import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FixedClock, RazorpayTestModeProvider } from '../src/provider.js';
import { addAttempt, createRecoveryCase, type RecoveryAction, type RecoveryCase } from '../src/domain.js';

const context = { customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 4999, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z' };
const clock = new FixedClock('2026-01-01T00:00:00.000Z');

function mandateCase(id = 'case-1'): RecoveryCase {
  return addAttempt(createRecoveryCase(id, context, '2026-01-01T00:00:00.000Z'), {
    id: `${id}:attempt:1`,
    providerPaymentId: 'pay_original',
    method: 'recurring_mandate',
    status: 'failed',
    failureCode: 'insufficient_funds',
    occurredAt: '2026-01-01T00:00:00.000Z',
  });
}

function action(kind: RecoveryAction['kind'], caseId = 'case-1'): RecoveryAction {
  return { id: `${caseId}:action:${kind}:1`, kind, status: 'pending', idempotencyKey: `${caseId}:${kind}`, createdAt: '2026-01-01T00:00:00.000Z' };
}

interface Recorded { readonly method: string; readonly url: string; readonly body: Record<string, unknown> }

/**
 * A Test Mode double for the endpoints the recurring retry uses: the original payment lookup (which
 * carries the order id the retry re-initiates against, per Razorpay's own documented semantics),
 * the payments already sitting on that order, and the recurring charge itself. No order is ever
 * created by a retry — it always re-initiates against the order the failed renewal already used.
 */
function razorpay(overrides: {
  payment?: Record<string, unknown> | null;
  paymentStatus?: number;
  recurring?: { status: number; body: Record<string, unknown> };
  /** Status Razorpay reports for a payment listed against the order. */
  chargeStatus?: string;
} = {}) {
  const requests: Recorded[] = [];
  const orderPayments = new Map<string, string>();
  let issued = 0;
  const payment = overrides.payment === undefined
    ? { id: 'pay_original', order_id: 'order_original', recurring: true, token_id: 'token_1', customer_id: 'cust_1', email: 'renewal@example.com', contact: '+919900000000', method: 'card' }
    : overrides.payment;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ method, url: url.toString(), body });
    if (method === 'GET' && url.pathname === '/v1/payments/pay_original') {
      return new Response(JSON.stringify(payment ?? { error: { description: 'payment not found' } }), { status: overrides.paymentStatus ?? (payment ? 200 : 400) });
    }
    const ofOrder = /^\/v1\/orders\/(?<orderId>[^/]+)\/payments$/.exec(url.pathname);
    if (method === 'GET' && ofOrder?.groups) {
      const existing = orderPayments.get(ofOrder.groups.orderId ?? '');
      return new Response(JSON.stringify({ items: existing === undefined ? [] : [{ id: existing, status: overrides.chargeStatus ?? 'captured' }] }), { status: 200 });
    }
    if (method === 'POST' && url.pathname === '/v1/payments/create/recurring') {
      if (overrides.recurring) return new Response(JSON.stringify(overrides.recurring.body), { status: overrides.recurring.status });
      issued += 1;
      const id = `pay_retry${issued}`;
      orderPayments.set(String(body.order_id ?? ''), id);
      return new Response(JSON.stringify({ razorpay_payment_id: id, razorpay_order_id: body.order_id }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { description: `unexpected ${method} ${url.pathname}` } }), { status: 404 });
  }) as unknown as typeof fetch;
  return { requests, provider: new RazorpayTestModeProvider({ keyId: 'rzp_test_key', keySecret: 'test_secret', webhookSecret: 'test_secret', recurringRetryEnabled: true, fetcher, clock }) };
}

describe('Razorpay Test Mode recurring retry', () => {
  it('charges the authorized mandate again against the order the failed renewal already used', async () => {
    // Razorpay's own retry semantics say "for the same order id" — creating a fresh order per
    // retry would not be the same operation, and would leave the 36-hour re-initiation window
    // Razorpay describes unmodelled.
    const { requests, provider } = razorpay();
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('submitted');
    expect(result.providerReference).toBe('pay_retry1');
    expect(requests.some((request) => request.method === 'POST' && request.url.endsWith('/v1/orders'))).toBe(false);
    const charge = requests.find((request) => request.url.endsWith('/v1/payments/create/recurring'));
    expect(charge?.body).toMatchObject({ token: 'token_1', customer_id: 'cust_1', email: 'renewal@example.com', contact: '+919900000000', order_id: 'order_original', currency: 'INR', amount: 4999, recurring: true });
    // `recurring` is a boolean because that is the type Razorpay's API reference gives it. Recurring
    // is not enabled on our Test Mode account, so this shape has never been exercised live.
  });

  /**
   * Razorpay does not document `recurring` on the payment-fetch response, so a payload without it
   * must still be chargeable — otherwise every real mandate payment is refused and the retry path
   * is unreachable. These pin that tolerance rather than leaving it to assumption.
   */
  it.each([
    ['absent', {}],
    ['boolean true', { recurring: true }],
    ['string "true"', { recurring: 'true' }],
    ['string "1"', { recurring: '1' }],
    ['number 1', { recurring: 1 }],
  ])('charges the mandate when the payment\'s recurring flag is %s', async (_label, flag) => {
    const { provider } = razorpay({
      payment: { id: 'pay_original', order_id: 'order_original', token_id: 'token_1', customer_id: 'cust_1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', ...flag },
    });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('submitted');
    expect(result.providerReference).toBe('pay_retry1');
  });

  it.each([
    ['boolean false', { recurring: false }],
    ['string "0"', { recurring: '0' }],
    ['number 0', { recurring: 0 }],
  ])('refuses the charge when the recurring flag is an explicit negative (%s)', async (_label, flag) => {
    const { requests, provider } = razorpay({
      payment: { id: 'pay_original', token_id: 'token_1', customer_id: 'cust_1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', ...flag },
    });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.providerReference).toBeUndefined();
    expect(requests.filter((request) => request.url.endsWith('/v1/payments/create/recurring'))).toHaveLength(0);
  });

  it.each([
    ['token_id', 'token_id'],
    ['customer_id', 'customer_id'],
    ['email', 'email'],
    ['contact', 'contact'],
  ])('still refuses the charge when the documented field %s is missing', async (_label, missing) => {
    const full: Record<string, unknown> = { id: 'pay_original', recurring: true, token_id: 'token_1', customer_id: 'cust_1', email: 'renewal@example.com', contact: '+919900000000', method: 'card' };
    delete full[missing];
    const { requests, provider } = razorpay({ payment: full });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(requests.filter((request) => request.url.endsWith('/v1/payments/create/recurring'))).toHaveLength(0);
  });

  it('replays the existing charge when the same retry is submitted twice', async () => {
    const { requests, provider } = razorpay();
    const first = await provider.submitRetry(mandateCase(), action('retry'));
    const second = await provider.submitRetry(mandateCase(), action('retry'));
    expect(second.idempotent).toBe(true);
    expect(second.providerReference).toBe(first.providerReference);
    expect(requests.filter((request) => request.url.endsWith('/v1/payments/create/recurring'))).toHaveLength(1);
  });

  it('charges again when the only payment on the order is a declined one', async () => {
    const { requests, provider } = razorpay({ chargeStatus: 'failed' });
    await provider.submitRetry(mandateCase(), action('retry'));
    const second = await provider.submitRetry(mandateCase(), action('retry'));
    expect(second.idempotent).toBeUndefined();
    expect(second.status).toBe('submitted');
    expect(requests.filter((request) => request.url.endsWith('/v1/payments/create/recurring'))).toHaveLength(2);
  });

  it('charges the latest failed mandate attempt rather than the oldest one on record', async () => {
    const { requests, provider } = razorpay();
    const twice = addAttempt(mandateCase(), { id: 'case-1:attempt:2', providerPaymentId: 'pay_original', method: 'recurring_mandate', status: 'failed', occurredAt: '2026-01-02T00:00:00.000Z' });
    const result = await provider.submitRetry(twice, action('retry'));
    expect(result.status).toBe('submitted');
    expect(requests.some((request) => request.url.endsWith('/v1/payments/pay_original'))).toBe(true);
  });

  it('refuses to charge when the original payment carries no authorized mandate token', async () => {
    const { requests, provider } = razorpay({ payment: { id: 'pay_original', order_id: 'order_original', recurring: false, method: 'card', email: 'renewal@example.com', contact: '+919900000000' } });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/mandate/i);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('maps a declined recurring charge to a failed result carrying the provider description', async () => {
    const { provider } = razorpay({ recurring: { status: 400, body: { error: { code: 'BAD_REQUEST_ERROR', description: 'Your payment could not be completed' } } } });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toContain('400');
    expect(result.message).toContain('Your payment could not be completed');
  });

  it('maps a failed original-payment lookup to a failed result instead of charging blind', async () => {
    const { requests, provider } = razorpay({ payment: null, paymentStatus: 500 });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toContain('500');
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('maps a transport failure to a failed result rather than throwing', async () => {
    const fetcher = (async () => { throw new Error('socket hang up'); }) as unknown as typeof fetch;
    const provider = new RazorpayTestModeProvider({ keyId: 'rzp_test_key', keySecret: 'test_secret', webhookSecret: 'test_secret', recurringRetryEnabled: true, fetcher, clock });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toContain('socket hang up');
  });

  it('refuses to charge when the original payment carries no order id to retry against', async () => {
    const { requests, provider } = razorpay({ payment: { id: 'pay_original', recurring: true, token_id: 'token_1', customer_id: 'cust_1', email: 'renewal@example.com', contact: '+919900000000', method: 'card' } });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/order id/i);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });
});

describe('Razorpay Test Mode fallback link', () => {
  it('keeps the reference_id within the 40-character identity Razorpay accepts', async () => {
    const { requests, provider } = razorpay();
    const long = { ...action('fallback_link'), idempotencyKey: `case-${'x'.repeat(60)}:fallback_link` };
    await provider.createFallbackLink(mandateCase(), long);
    const link = requests.find((request) => request.method === 'POST' && request.url.endsWith('/v1/payment_links'));
    expect(String(link?.body.reference_id).length).toBeLessThanOrEqual(40);
    expect(String(link?.body.reference_id)).not.toBe(long.idempotencyKey);
  });
});

describe('Razorpay Test Mode safety', () => {
  it('refuses to charge again once any attempt on the case has succeeded', async () => {
    const { requests, provider } = razorpay();
    const paid = addAttempt(mandateCase('case-paid'), {
      id: 'case-paid:attempt:2', providerPaymentId: 'pay_second', method: 'recurring_mandate', status: 'succeeded', occurredAt: '2026-01-02T00:00:00.000Z',
    });
    expect((await provider.retryEligibility(paid)).eligible).toBe(false);
    const result = await provider.submitRetry(paid, action('retry', 'case-paid'));
    expect(result.status).toBe('failed');
    expect(requests).toEqual([]);
  });


  it('refuses every money operation when the credentials are not Test Mode keys', async () => {
    const requests: string[] = [];
    const fetcher = (async (input: string | URL | Request) => { requests.push(String(input)); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const provider = new RazorpayTestModeProvider({ keyId: 'rzp_live_key', keySecret: 'live_secret', webhookSecret: 'test_secret', recurringRetryEnabled: true, fetcher, clock });
    const retry = await provider.submitRetry(mandateCase(), action('retry'));
    const link = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    expect(retry.status).toBe('failed');
    expect(retry.message).toMatch(/test mode/i);
    expect(link.status).toBe('failed');
    expect(link.message).toMatch(/test mode/i);
    expect(requests).toEqual([]);
  });

  it('verifies webhooks with the webhook secret when one is configured', () => {
    const provider = new RazorpayTestModeProvider({ keyId: 'rzp_test_key', keySecret: 'test_secret', webhookSecret: 'hook_secret', recurringRetryEnabled: true, clock });
    const signed = createHmac('sha256', 'hook_secret').update('{"a":1}').digest('hex');
    expect(provider.verifyEvent('{"a":1}', signed)).toBe(true);
    expect(provider.verifyEvent('{"a":1}', createHmac('sha256', 'test_secret').update('{"a":1}').digest('hex'))).toBe(false);
  });
});
