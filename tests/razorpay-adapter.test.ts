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
 * A Test Mode double for the endpoints the recurring retry uses: the original payment lookup,
 * order creation keyed by receipt, the payments of an order, and the recurring charge itself.
 */
function razorpay(overrides: {
  payment?: Record<string, unknown> | null;
  paymentStatus?: number;
  recurring?: { status: number; body: Record<string, unknown> };
  /** Status Razorpay reports for a payment listed against the order. */
  chargeStatus?: string;
} = {}) {
  const requests: Recorded[] = [];
  const orders = new Map<string, string>();
  const orderPayments = new Map<string, string>();
  let issued = 0;
  const payment = overrides.payment === undefined
    ? { id: 'pay_original', recurring: true, token_id: 'token_1', customer_id: 'cust_1', email: 'renewal@example.com', contact: '+919900000000', method: 'card' }
    : overrides.payment;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ method, url: url.toString(), body });
    if (method === 'GET' && url.pathname === '/v1/payments/pay_original') {
      return new Response(JSON.stringify(payment ?? { error: { description: 'payment not found' } }), { status: overrides.paymentStatus ?? (payment ? 200 : 400) });
    }
    if (method === 'GET' && url.pathname === '/v1/orders') {
      const receipt = url.searchParams.get('receipt') ?? '';
      const existing = orders.get(receipt);
      return new Response(JSON.stringify({ items: existing === undefined ? [] : [{ id: existing, receipt }] }), { status: 200 });
    }
    if (method === 'POST' && url.pathname === '/v1/orders') {
      issued += 1;
      const id = `order_Rz${issued}`;
      orders.set(String(body.receipt ?? ''), id);
      return new Response(JSON.stringify({ id, receipt: body.receipt, amount: body.amount, currency: body.currency }), { status: 200 });
    }
    const ofOrder = /^\/v1\/orders\/(?<orderId>[^/]+)\/payments$/.exec(url.pathname);
    if (method === 'GET' && ofOrder?.groups) {
      const existing = orderPayments.get(ofOrder.groups.orderId ?? '');
      return new Response(JSON.stringify({ items: existing === undefined ? [] : [{ id: existing, status: overrides.chargeStatus ?? 'captured' }] }), { status: 200 });
    }
    if (method === 'POST' && url.pathname === '/v1/payments/create/recurring') {
      if (overrides.recurring) return new Response(JSON.stringify(overrides.recurring.body), { status: overrides.recurring.status });
      const id = `pay_retry${issued}`;
      orderPayments.set(String(body.order_id ?? ''), id);
      return new Response(JSON.stringify({ razorpay_payment_id: id, razorpay_order_id: body.order_id }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { description: `unexpected ${method} ${url.pathname}` } }), { status: 404 });
  }) as unknown as typeof fetch;
  return { requests, provider: new RazorpayTestModeProvider({ keyId: 'rzp_test_key', keySecret: 'test_secret', fetcher, clock }) };
}

describe('Razorpay Test Mode recurring retry', () => {
  it('charges the authorized mandate again through an order carrying the action identity', async () => {
    const { requests, provider } = razorpay();
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('submitted');
    expect(result.providerReference).toBe('pay_retry1');
    const order = requests.find((request) => request.method === 'POST' && request.url.endsWith('/v1/orders'));
    expect(order?.body.receipt).toBe('case-1:retry');
    expect(order?.body.amount).toBe(4999);
    expect(order?.body.currency).toBe('INR');
    const charge = requests.find((request) => request.url.endsWith('/v1/payments/create/recurring'));
    expect(charge?.body).toMatchObject({ token: 'token_1', customer_id: 'cust_1', email: 'renewal@example.com', contact: '+919900000000', order_id: 'order_Rz1', currency: 'INR', amount: 4999, recurring: '1' });
  });

  it('replays the existing charge when the same action identity is submitted twice', async () => {
    const { requests, provider } = razorpay();
    const first = await provider.submitRetry(mandateCase(), action('retry'));
    const second = await provider.submitRetry(mandateCase(), action('retry'));
    expect(second.idempotent).toBe(true);
    expect(second.providerReference).toBe(first.providerReference);
    expect(requests.filter((request) => request.url.endsWith('/v1/payments/create/recurring'))).toHaveLength(1);
    expect(requests.filter((request) => request.method === 'POST' && request.url.endsWith('/v1/orders'))).toHaveLength(1);
  });

  it('charges again when the only payment on the order is a declined one', async () => {
    const { requests, provider } = razorpay({ chargeStatus: 'failed' });
    await provider.submitRetry(mandateCase(), action('retry'));
    const second = await provider.submitRetry(mandateCase(), action('retry'));
    expect(second.idempotent).toBeUndefined();
    expect(second.status).toBe('submitted');
    expect(requests.filter((request) => request.url.endsWith('/v1/payments/create/recurring'))).toHaveLength(2);
    // The order is reused rather than duplicated, so the identity still owns one order.
    expect(requests.filter((request) => request.method === 'POST' && request.url.endsWith('/v1/orders'))).toHaveLength(1);
  });

  it('charges the latest failed mandate attempt rather than the oldest one on record', async () => {
    const { requests, provider } = razorpay();
    const twice = addAttempt(mandateCase(), { id: 'case-1:attempt:2', providerPaymentId: 'pay_original', method: 'recurring_mandate', status: 'failed', occurredAt: '2026-01-02T00:00:00.000Z' });
    const result = await provider.submitRetry(twice, action('retry'));
    expect(result.status).toBe('submitted');
    expect(requests.some((request) => request.url.endsWith('/v1/payments/pay_original'))).toBe(true);
  });

  it('refuses to charge when the original payment carries no authorized mandate token', async () => {
    const { requests, provider } = razorpay({ payment: { id: 'pay_original', recurring: false, method: 'card', email: 'renewal@example.com', contact: '+919900000000' } });
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
    const provider = new RazorpayTestModeProvider({ keyId: 'rzp_test_key', keySecret: 'test_secret', fetcher, clock });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toContain('socket hang up');
  });

  it('keeps the provider reference within the 40-character identity Razorpay accepts', async () => {
    const { requests, provider } = razorpay();
    const long = { ...action('retry'), idempotencyKey: `case-${'x'.repeat(60)}:retry` };
    await provider.submitRetry(mandateCase(), long);
    const order = requests.find((request) => request.method === 'POST' && request.url.endsWith('/v1/orders'));
    expect(String(order?.body.receipt).length).toBeLessThanOrEqual(40);
    expect(String(order?.body.receipt)).not.toBe(long.idempotencyKey);
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
    const provider = new RazorpayTestModeProvider({ keyId: 'rzp_live_key', keySecret: 'live_secret', fetcher, clock });
    const retry = await provider.submitRetry(mandateCase(), action('retry'));
    const link = await provider.createFallbackLink(mandateCase(), action('fallback_link'));
    expect(retry.status).toBe('failed');
    expect(retry.message).toMatch(/test mode/i);
    expect(link.status).toBe('failed');
    expect(link.message).toMatch(/test mode/i);
    expect(requests).toEqual([]);
  });

  it('verifies webhooks with the webhook secret when one is configured', () => {
    const provider = new RazorpayTestModeProvider({ keyId: 'rzp_test_key', keySecret: 'test_secret', webhookSecret: 'hook_secret', clock });
    const signed = createHmac('sha256', 'hook_secret').update('{"a":1}').digest('hex');
    expect(provider.verifyEvent('{"a":1}', signed)).toBe(true);
    expect(provider.verifyEvent('{"a":1}', createHmac('sha256', 'test_secret').update('{"a":1}').digest('hex'))).toBe(false);
  });
});
