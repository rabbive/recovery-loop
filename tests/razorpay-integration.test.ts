import { describe, expect, it } from 'vitest';
import { RazorpayTestModeProvider, SystemClock } from '../src/provider.js';
import { addAttempt, createRecoveryCase, type RecoveryCase } from '../src/domain.js';

/**
 * The optional live path. It is skipped unless Razorpay Test Mode credentials are exported, and the
 * adapter itself refuses anything but an `rzp_test_` key, so this suite cannot move real money.
 * Run it with: RAZORPAY_KEY_ID=rzp_test_... RAZORPAY_KEY_SECRET=... npm test
 */
const keyId = process.env.RAZORPAY_KEY_ID ?? '';
const keySecret = process.env.RAZORPAY_KEY_SECRET ?? '';
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';
const configured = keyId.startsWith('rzp_test_') && keySecret.length > 0;

function renewalCase(id: string): RecoveryCase {
  const at = new Date().toISOString();
  return addAttempt(createRecoveryCase(id, { customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 4999, currency: 'INR', dueAt: at }, at), {
    id: `${id}:attempt:1`, providerPaymentId: 'pay_absent', method: 'recurring_mandate', status: 'failed', occurredAt: at,
  });
}

describe.skipIf(!configured)('Razorpay Test Mode integration', () => {
  const provider = new RazorpayTestModeProvider({ keyId, keySecret, webhookSecret, clock: new SystemClock() });

  it('creates a real expiring Test Mode payment link and replays the same action identity', async () => {
    const recoveryCase = renewalCase(`itest-${Date.now()}`);
    const action = { id: `${recoveryCase.id}:action:1`, kind: 'fallback_link' as const, status: 'pending' as const, idempotencyKey: `${recoveryCase.id}:fallback_link`, createdAt: recoveryCase.createdAt };
    const created = await provider.createFallbackLink(recoveryCase, action);
    expect(created.status).toBe('submitted');
    expect(created.providerReference).toMatch(/^plink_/);
    expect(Date.parse(created.expiresAt)).toBeGreaterThan(Date.now());
    const replay = await provider.createFallbackLink(recoveryCase, action);
    expect(replay.idempotent).toBe(true);
    expect(replay.providerReference).toBe(created.providerReference);
  }, 30_000);

  it('keeps the unproven recurring retry disabled without a network charge', async () => {
    const recoveryCase = renewalCase(`itest-retry-${Date.now()}`);
    const result = await provider.submitRetry(recoveryCase, { id: `${recoveryCase.id}:action:2`, kind: 'retry', status: 'pending', idempotencyKey: `${recoveryCase.id}:retry`, createdAt: recoveryCase.createdAt });
    expect(result.status).toBe('failed');
    expect(result.providerReference).toBeUndefined();
    expect(result.message).toMatch(/unverified and disabled/i);
  }, 30_000);
});
