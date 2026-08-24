import { describe, expect, it } from 'vitest';
import { DeterministicSimulator, FixedClock, RazorpayTestModeProvider, type PaymentProvider } from '../src/provider.js';
import { addAttempt, createRecoveryCase, type RecoveryAction, type RecoveryCase } from '../src/domain.js';

const context = { customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 4999, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z' };

function mandateCase(id = 'case-1'): RecoveryCase {
  return addAttempt(createRecoveryCase(id, context, '2026-01-01T00:00:00.000Z'), {
    id: `${id}:attempt:1`,
    providerPaymentId: 'pay_1',
    method: 'recurring_mandate',
    status: 'failed',
    failureCode: 'insufficient_funds',
    occurredAt: '2026-01-01T00:00:00.000Z',
  });
}

function cardCase(id = 'card-1'): RecoveryCase {
  return addAttempt(createRecoveryCase(id, context, '2026-01-01T00:00:00.000Z'), {
    id: `${id}:attempt:1`,
    providerPaymentId: 'pay_2',
    method: 'card',
    status: 'failed',
    occurredAt: '2026-01-01T00:00:00.000Z',
  });
}

function action(kind: RecoveryAction['kind'], caseId = 'case-1'): RecoveryAction {
  return { id: `${caseId}:action:${kind}:1`, kind, status: 'pending', idempotencyKey: `${caseId}:${kind}`, createdAt: '2026-01-01T00:00:00.000Z' };
}

const clock = new FixedClock('2026-01-01T00:00:00.000Z');

/**
 * A Test Mode fetcher that records requests and answers like Razorpay: opaque payment-link ids,
 * a 400 when a reference_id is reused, and a list endpoint that resolves a reference to its link.
 */
function razorpay(handler?: (url: string, init: RequestInit) => Response) {
  const requests: { url: string; init: RequestInit }[] = [];
  const links = new Map<string, string>();
  let issued = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const record = { url: String(url), init: init ?? {} };
    requests.push(record);
    if (handler) return handler(record.url, record.init);
    const parsed = new URL(record.url);
    if ((record.init.method ?? 'GET') === 'GET') {
      const reference = parsed.searchParams.get('reference_id') ?? '';
      const existing = links.get(reference);
      return new Response(JSON.stringify({ payment_links: existing === undefined ? [] : [{ id: existing, reference_id: reference }] }), { status: 200 });
    }
    const body = JSON.parse(String(record.init.body ?? '{}')) as { reference_id?: string };
    const reference = body.reference_id ?? '';
    if (links.has(reference)) {
      return new Response(JSON.stringify({ error: { code: 'BAD_REQUEST_ERROR', description: `Payment link with reference id ${reference} already exists` } }), { status: 400 });
    }
    issued += 1;
    const id = `plink_Op${issued}aQ`;
    links.set(reference, id);
    return new Response(JSON.stringify({ id, reference_id: reference, short_url: 'https://rzp.io/i/test', status: 'created' }), { status: 200 });
  }) as unknown as typeof fetch;
  return { requests, provider: new RazorpayTestModeProvider({ keyId: 'rzp_test_key', keySecret: 'test_secret', fetcher, clock }) };
}

const implementations: readonly { name: string; make: () => PaymentProvider; signature: (raw: string) => string }[] = [
  {
    name: 'DeterministicSimulator',
    make: () => new DeterministicSimulator(new Map([['case-1', { retry: 'success', fallback: 'success', diagnosis: 'transient' }]]), clock),
    signature: (raw) => `sim:${raw}`,
  },
  {
    name: 'RazorpayTestModeProvider',
    make: () => razorpay().provider,
    signature: (raw) => new RazorpayTestModeProvider({ keyId: 'rzp_test_key', keySecret: 'test_secret', clock }).signPayload(raw),
  },
];

describe.each(implementations)('payment provider contract: $name', ({ make, signature }) => {
  it('accepts a correctly signed event and rejects anything else', () => {
    const provider = make();
    expect(provider.verifyEvent('{"a":1}', signature('{"a":1}'))).toBe(true);
    expect(provider.verifyEvent('{"a":1}', 'wrong')).toBe(false);
    expect(provider.verifyEvent('', signature(''))).toBe(false);
    expect(provider.verifyEvent('{"a":1}', '')).toBe(false);
  });

  it('normalizes an event without inventing fields', () => {
    const provider = make();
    const event = provider.normalizeEvent({ id: 'evt_1', type: 'payment_failed', caseId: 'case-1', providerPaymentId: 'pay_1', occurredAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:05.000Z');
    expect(event).toMatchObject({ id: 'evt_1', type: 'payment_failed', caseId: 'case-1', providerPaymentId: 'pay_1', receivedAt: '2026-01-01T00:00:05.000Z' });
    expect(event.payload).toEqual({});
    expect(provider.normalizeEvent({ id: 'evt_2', type: 'unknown', caseId: 'case-1', occurredAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:05.000Z').type).toBe('unknown');
  });

  it('reports retry eligibility from the payment method rather than from the recommendation', async () => {
    const provider = make();
    expect((await provider.retryEligibility(mandateCase())).eligible).toBe(true);
    const ineligible = await provider.retryEligibility(cardCase());
    expect(ineligible.eligible).toBe(false);
    expect(ineligible.reason.length).toBeGreaterThan(0);
  });

  it('creates a fallback link that expires after the current time', async () => {
    const provider = make();
    const result = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    expect(['submitted', 'succeeded']).toContain(result.status);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(clock.now().getTime());
  });

  it('treats a repeated action identity as the same operation instead of a second money action', async () => {
    const provider = make();
    const first = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    const second = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    expect(second.status).toBe(first.status);
    expect(second.providerReference).toBe(first.providerReference);
    expect(second.idempotent).toBe(true);
  });

  it('maps provider failure to a result instead of throwing', async () => {
    const provider = make();
    const result = await provider.submitRetry(cardCase(), action('retry', 'card-1'));
    expect(['failed', 'submitted', 'succeeded']).toContain(result.status);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('RazorpayTestModeProvider', () => {
  it('creates a Test Mode payment link carrying the action identity as its reference', async () => {
    const { requests, provider } = razorpay();
    const result = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    expect(result.status).toBe('submitted');
    expect(result.providerReference).toBe('plink_Op1aQ');
    const request = requests[0];
    expect(request?.url).toBe('https://api.razorpay.com/v1/payment_links');
    const headers = request?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('rzp_test_key:test_secret').toString('base64')}`);
    const body = JSON.parse(String(request?.init.body)) as Record<string, unknown>;
    expect(body.reference_id).toBe('case-1:fallback_link');
    expect(body.amount).toBe(4999);
    expect(body.currency).toBe('INR');
    expect(body.expire_by).toBe(Math.floor(clock.now().getTime() / 1000) + 24 * 60 * 60);
  });

  it('resolves a duplicate reference to the real existing link instead of inventing an id', async () => {
    const { requests, provider } = razorpay();
    const first = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    const repeat = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    expect(repeat.idempotent).toBe(true);
    expect(repeat.status).toBe('submitted');
    expect(repeat.providerReference).toBe(first.providerReference);
    const lookup = requests.find((request) => (request.init.method ?? 'GET') === 'GET');
    expect(lookup?.url).toContain('reference_id=case-1%3Afallback_link');
  });

  it('reports no provider reference when the existing link cannot be resolved', async () => {
    let posts = 0;
    const { provider } = razorpay((url, init) => {
      if ((init.method ?? 'GET') === 'GET') return new Response('', { status: 500 });
      posts += 1;
      return posts === 1
        ? new Response(JSON.stringify({ id: 'plink_Op1aQ', reference_id: 'case-1:fallback_link' }), { status: 200 })
        : new Response(JSON.stringify({ error: { description: 'Payment link with reference id case-1:fallback_link already exists' } }), { status: 400 });
    });
    await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    const repeat = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    expect(repeat.idempotent).toBe(true);
    expect(repeat.providerReference).toBeUndefined();
    expect(repeat.message).toMatch(/could not be resolved/i);
  });

  it('fails when a created link comes back without an id', async () => {
    const { provider } = razorpay(() => new Response(JSON.stringify({ reference_id: 'case-1:fallback_link' }), { status: 200 }));
    const result = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    expect(result.status).toBe('failed');
    expect(result.providerReference).toBeUndefined();
  });

  it('maps a provider outage to a failed result', async () => {
    const { provider } = razorpay(() => new Response(JSON.stringify({ error: { description: 'gateway down' } }), { status: 502 }));
    const result = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    expect(result.status).toBe('failed');
    expect(result.message).toContain('502');
  });

  it('refuses to claim support for retrying an arbitrary card payment', async () => {
    const { provider } = razorpay();
    const eligibility = await provider.retryEligibility(cardCase());
    expect(eligibility.eligible).toBe(false);
    const result = await provider.submitRetry(cardCase(), action('retry', 'card-1'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/mandate/i);
  });

  it('fails without moving money when credentials are missing', async () => {
    const provider = new RazorpayTestModeProvider({ keyId: '', keySecret: '', clock });
    expect((await provider.submitRetry(mandateCase(), action('retry'))).status).toBe('failed');
    expect((await provider.createFallbackLink(mandateCase(), action('fallback_link'))).status).toBe('failed');
  });
});

describe('DeterministicSimulator', () => {
  it('produces identical results for the same scenario and clock', async () => {
    const scenario = new Map([['case-1', { retry: 'failure' as const, fallback: 'success' as const, diagnosis: 'transient' as const }]]);
    const first = new DeterministicSimulator(scenario, new FixedClock('2026-01-01T00:00:00.000Z'));
    const second = new DeterministicSimulator(scenario, new FixedClock('2026-01-01T00:00:00.000Z'));
    expect(await first.submitRetry(mandateCase(), action('retry'))).toEqual(await second.submitRetry(mandateCase(), action('retry')));
    expect(await first.createFallbackLink(mandateCase(), action('fallback_link'))).toEqual(await second.createFallbackLink(mandateCase(), action('fallback_link')));
  });

  it('expires fallback links relative to the injected clock', async () => {
    const advancing = new FixedClock('2026-01-01T00:00:00.000Z');
    const provider = new DeterministicSimulator(new Map(), advancing);
    const before = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    advancing.advance(60 * 60 * 1000);
    const after = await provider.createFallbackLink(mandateCase('case-2'), action('fallback_link', 'case-2'));
    expect(Date.parse(after.expiresAt) - Date.parse(before.expiresAt)).toBe(60 * 60 * 1000);
  });

  it('records one provider call per distinct action identity', async () => {
    const provider = new DeterministicSimulator(new Map(), clock);
    await provider.submitRetry(mandateCase(), action('retry'));
    await provider.submitRetry(mandateCase(), action('retry'));
    await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    expect(provider.calls.map((call) => call.idempotencyKey)).toEqual(['case-1:retry', 'case-1:fallback_link']);
  });
});
