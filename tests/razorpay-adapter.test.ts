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

const originalPayment = {
  id: 'pay_original', order_id: 'order-1', amount: 4999, currency: 'INR', recurring: true,
  token_id: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com',
  contact: '+919900000000', method: 'card', notes: { caseId: 'case-1', subscriptionId: 'subscription-1' },
};

const validActionOrder = {
  id: 'order_retry_existing', receipt: 'case-1:retry', amount: 4999, currency: 'INR',
  notes: { caseId: 'case-1', subscriptionId: 'subscription-1', recoveryActionKey: 'case-1:retry' },
};

/** A stateful Test Mode double for the provider objects a recurring retry reads and creates. */
function razorpay(overrides: {
  payment?: Record<string, unknown> | null;
  paymentStatus?: number;
  originalOrder?: Record<string, unknown> | null;
  recurring?: { status: number; body: Record<string, unknown> };
  existingActionPaymentStatus?: string;
  duplicateOrder?: boolean;
  orderLookupPayload?: Record<string, unknown>;
  orderPaymentsPayload?: Record<string, unknown>;
} = {}) {
  const requests: Recorded[] = [];
  const ordersByReceipt = new Map<string, Record<string, unknown>>();
  const orderPayments = new Map<string, Array<{ id: string; status: string }>>();
  let issued = 0;
  const payment = overrides.payment === undefined
    ? originalPayment
    : overrides.payment === null
      ? null
      : { amount: originalPayment.amount, currency: originalPayment.currency, ...overrides.payment };
  const originalOrder = overrides.originalOrder === undefined
    ? { id: 'order-1', amount: 4999, currency: 'INR', notes: { caseId: 'case-1', subscriptionId: 'subscription-1' } }
    : overrides.originalOrder;
  if (overrides.existingActionPaymentStatus !== undefined) {
    ordersByReceipt.set('case-1:retry', validActionOrder);
    orderPayments.set('order_retry_existing', [{ id: 'pay_retry_existing', status: overrides.existingActionPaymentStatus }]);
  }
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const body = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push({ method, url: url.toString(), body });
    if (method === 'GET' && url.pathname === '/v1/payments/pay_original') {
      return new Response(JSON.stringify(payment ?? { error: { description: 'payment not found' } }), { status: overrides.paymentStatus ?? (payment ? 200 : 400) });
    }
    if (method === 'GET' && url.pathname === '/v1/orders/order-1') {
      return new Response(JSON.stringify(originalOrder ?? { error: { description: 'order not found' } }), { status: originalOrder ? 200 : 404 });
    }
    if (method === 'GET' && url.pathname === '/v1/orders') {
      const existing = ordersByReceipt.get(url.searchParams.get('receipt') ?? '');
      return new Response(JSON.stringify(overrides.orderLookupPayload ?? { items: existing === undefined ? [] : [existing] }), { status: 200 });
    }
    const ofOrder = /^\/v1\/orders\/(?<orderId>[^/]+)\/payments$/.exec(url.pathname);
    if (method === 'GET' && ofOrder?.groups) {
      return new Response(JSON.stringify(overrides.orderPaymentsPayload ?? { items: orderPayments.get(ofOrder.groups.orderId ?? '') ?? [] }), { status: 200 });
    }
    if (method === 'POST' && url.pathname === '/v1/orders') {
      const receipt = String(body.receipt ?? '');
      const created = { id: `order_retry${ordersByReceipt.size + 1}`, ...body };
      ordersByReceipt.set(receipt, created);
      if (overrides.duplicateOrder) {
        return new Response(JSON.stringify({ error: { description: 'Order with this receipt already exists' } }), { status: 400 });
      }
      return new Response(JSON.stringify(created), { status: 200 });
    }
    if (method === 'POST' && url.pathname === '/v1/payments/create/recurring') {
      if (overrides.recurring) return new Response(JSON.stringify(overrides.recurring.body), { status: overrides.recurring.status });
      issued += 1;
      const id = `pay_retry${issued}`;
      orderPayments.set(String(body.order_id ?? ''), [{ id, status: 'created' }]);
      return new Response(JSON.stringify({ razorpay_payment_id: id, razorpay_order_id: body.order_id }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: { description: `unexpected ${method} ${url.pathname}` } }), { status: 404 });
  }) as unknown as typeof fetch;
  return { requests, provider: new RazorpayTestModeProvider({ keyId: 'rzp_test_key', keySecret: 'test_secret', webhookSecret: 'test_secret', recurringRetryEnabled: true, fetcher, clock }) };
}

describe('Razorpay Test Mode recurring retry', () => {
  it('creates one fresh action-keyed order and carries the action identity into the charge', async () => {
    const { requests, provider } = razorpay();
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('submitted');
    expect(result.providerReference).toBe('pay_retry1');
    const createdOrders = requests.filter((request) => request.method === 'POST' && request.url.endsWith('/v1/orders'));
    expect(createdOrders).toHaveLength(1);
    expect(createdOrders[0]?.body).toEqual({
      amount: 4999,
      currency: 'INR',
      receipt: 'case-1:retry',
      notes: { caseId: 'case-1', subscriptionId: 'subscription-1', recoveryActionKey: 'case-1:retry' },
    });
    const charge = requests.find((request) => request.url.endsWith('/v1/payments/create/recurring'));
    expect(charge?.body).toEqual({
      token: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com', contact: '+919900000000',
      order_id: 'order_retry1', currency: 'INR', amount: 4999, recurring: true,
      description: 'Renewal recovery for order order-1',
      notes: { caseId: 'case-1', subscriptionId: 'subscription-1', recoveryActionKey: 'case-1:retry' },
    });
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
      payment: { id: 'pay_original', order_id: 'order-1', token_id: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', notes: { subscriptionId: 'subscription-1' }, ...flag },
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
      payment: { id: 'pay_original', order_id: 'order-1', token_id: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', notes: { subscriptionId: 'subscription-1' }, ...flag },
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
    const full: Record<string, unknown> = { id: 'pay_original', order_id: 'order-1', recurring: true, token_id: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', notes: { subscriptionId: 'subscription-1' } };
    delete full[missing];
    const { requests, provider } = razorpay({ payment: full });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(requests.filter((request) => request.url.endsWith('/v1/payments/create/recurring'))).toHaveLength(0);
  });

  it('replays a created payment for the same action without a second charge', async () => {
    const { requests, provider } = razorpay();
    const first = await provider.submitRetry(mandateCase(), action('retry'));
    const second = await provider.submitRetry(mandateCase(), action('retry'));
    expect(second.idempotent).toBe(true);
    expect(second.providerReference).toBe(first.providerReference);
    expect(requests.filter((request) => request.url.endsWith('/v1/payments/create/recurring'))).toHaveLength(1);
  });

  it.each(['created', 'failed', 'authorized', 'captured'])('treats an existing %s payment as the same action', async (status) => {
    const { requests, provider } = razorpay({ existingActionPaymentStatus: status });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.idempotent).toBe(true);
    expect(result.providerReference).toBe('pay_retry_existing');
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it.each([
    ['amount', { ...originalPayment, amount: 5000 }],
    ['currency', { ...originalPayment, currency: 'USD' }],
  ])('refuses before any POST when the provider %s differs from the registered case', async (_label, payment) => {
    const { requests, provider } = razorpay({ payment });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/identity/i);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it.each([
    ['receipt', { ...validActionOrder, receipt: 'case-other:retry' }],
    ['case note', { ...validActionOrder, notes: { ...validActionOrder.notes, caseId: 'case-other' } }],
    ['subscription note', { ...validActionOrder, notes: { ...validActionOrder.notes, subscriptionId: 'subscription-other' } }],
    ['action note', { ...validActionOrder, notes: { ...validActionOrder.notes, recoveryActionKey: 'case-other:retry' } }],
    ['amount', { ...validActionOrder, amount: 5000 }],
    ['currency', { ...validActionOrder, currency: 'USD' }],
  ])('refuses an action-order lookup with the wrong %s before reading payments or charging', async (_label, returnedOrder) => {
    const { requests, provider } = razorpay({ orderLookupPayload: { items: [returnedOrder] } });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(requests.some((request) => request.url.endsWith('/v1/orders/order_retry_existing/payments'))).toBe(false);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('resolves a duplicate-order response through the action lookup and charges that order once', async () => {
    const { requests, provider } = razorpay({ duplicateOrder: true });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('submitted');
    expect(result.providerReference).toBe('pay_retry1');
    expect(requests.filter((request) => request.method === 'POST' && request.url.endsWith('/v1/orders'))).toHaveLength(1);
    expect(requests.filter((request) => request.url.endsWith('/v1/payments/create/recurring'))).toHaveLength(1);
  });

  it('refuses a duplicate-order response that replays to no order at all', async () => {
    const { requests, provider } = razorpay({ duplicateOrder: true, orderLookupPayload: { items: [] } });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/no order exists for this action identity/);
    expect(requests.filter((request) => request.url.endsWith('/v1/payments/create/recurring'))).toHaveLength(0);
  });

  it.each([{}, { items: [{}] }])('does not create an order when the action-order lookup response is malformed', async (orderLookupPayload) => {
    const { requests, provider } = razorpay({ orderLookupPayload });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it.each([{}, { items: [{}] }])('does not charge when the action-order payment lookup response is malformed', async (orderPaymentsPayload) => {
    const { requests, provider } = razorpay({ orderPaymentsPayload });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(requests.filter((request) => request.url.endsWith('/v1/payments/create/recurring'))).toHaveLength(0);
  });

  it('refuses an order lookup whose first item is not an order object', async () => {
    const { requests, provider } = razorpay({ orderLookupPayload: { items: [42] } });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/malformed retry-order lookup/);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('refuses when the original order subscription identity cannot be verified', async () => {
    const { requests, provider } = razorpay({
      payment: { id: 'pay_original', order_id: 'order-1', recurring: true, token_id: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', notes: {} },
      originalOrder: null,
    });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/could not verify the original order subscription identity/i);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('accepts the registered subscription identity from the original order notes', async () => {
    const { provider } = razorpay({
      payment: { id: 'pay_original', order_id: 'order-1', recurring: true, token_id: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', notes: {} },
    });
    expect((await provider.submitRetry(mandateCase(), action('retry'))).status).toBe('submitted');
  });

  it.each([
    ['customer', { payment: { id: 'pay_original', order_id: 'order-1', recurring: true, token_id: 'token_1', customer_id: 'customer-other', email: 'renewal@example.com', contact: '+919900000000', method: 'card', notes: { subscriptionId: 'subscription-1' } } }],
    ['order', { payment: { id: 'pay_original', order_id: 'order-other', recurring: true, token_id: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', notes: { subscriptionId: 'subscription-1' } } }],
    ['payment subscription', { payment: { id: 'pay_original', order_id: 'order-1', recurring: true, token_id: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', notes: { subscriptionId: 'subscription-other' } } }],
    ['order subscription', { payment: { id: 'pay_original', order_id: 'order-1', recurring: true, token_id: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', notes: {} }, originalOrder: { id: 'order-1', notes: { subscriptionId: 'subscription-other' } } }],
  ])('refuses before any POST when the provider %s identity disagrees with the case', async (_label, overrides) => {
    const { requests, provider } = razorpay(overrides);
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/identity/i);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
  });

  it('charges the latest failed mandate attempt rather than the oldest one on record', async () => {
    const { requests, provider } = razorpay();
    const twice = addAttempt(mandateCase(), { id: 'case-1:attempt:2', providerPaymentId: 'pay_original', method: 'recurring_mandate', status: 'failed', occurredAt: '2026-01-02T00:00:00.000Z' });
    const result = await provider.submitRetry(twice, action('retry'));
    expect(result.status).toBe('submitted');
    expect(requests.some((request) => request.url.endsWith('/v1/payments/pay_original'))).toBe(true);
  });

  it('refuses to charge when the original payment carries no authorized mandate token', async () => {
    const { requests, provider } = razorpay({ payment: { id: 'pay_original', order_id: 'order-1', recurring: false, method: 'card', email: 'renewal@example.com', contact: '+919900000000' } });
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

  it('refuses to charge when the original payment carries no amount and currency identity', async () => {
    const { requests, provider } = razorpay({ payment: { id: 'pay_original', order_id: 'order-1', recurring: true, token_id: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', notes: {}, amount: undefined, currency: undefined } });
    const result = await provider.submitRetry(mandateCase(), action('retry'));
    expect(result.status).toBe('failed');
    expect(result.message).toMatch(/no amount and currency identity/);
    expect(requests.some((request) => request.method === 'POST')).toBe(false);
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
    const { requests, provider } = razorpay({ payment: { id: 'pay_original', recurring: true, token_id: 'token_1', customer_id: 'customer-1', email: 'renewal@example.com', contact: '+919900000000', method: 'card', notes: { subscriptionId: 'subscription-1' } } });
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
