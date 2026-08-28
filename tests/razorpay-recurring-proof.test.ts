import { describe, expect, it } from 'vitest';
import { RazorpayTestModeProvider, SystemClock } from '../src/provider.js';
import { addAttempt, createRecoveryCase, type RecoveryCase } from '../src/domain.js';

/**
 * The proof that the recurring mandate charge works. It has never been run: the account has no
 * recurring-enabled mandate, so `RAZORPAY_RECURRING_RETRY_ENABLED` ships false and the adapter
 * refuses the charge without touching the network.
 *
 * This suite is what would change that. It charges a real Test Mode mandate, so it stays skipped
 * unless every input below is exported, and it asserts what Razorpay actually answered rather than
 * recording a claim. Running it green is the only thing that earns the right to enable the flag.
 *
 * Nothing here contains credentials, customer details, or card data — every input is read from the
 * environment, and the payment and customer identifiers name Test Mode objects.
 */
const keyId = process.env.RAZORPAY_KEY_ID ?? '';
const keySecret = process.env.RAZORPAY_KEY_SECRET ?? '';
const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? '';
const paymentId = process.env.RAZORPAY_RECURRING_PROOF_PAYMENT_ID ?? '';
const customerId = process.env.RAZORPAY_RECURRING_PROOF_CUSTOMER_ID ?? '';
const amount = Number(process.env.RAZORPAY_RECURRING_PROOF_AMOUNT ?? '');
const currency = process.env.RAZORPAY_RECURRING_PROOF_CURRENCY ?? '';
const configured = keyId.startsWith('rzp_test_')
  && keySecret.length > 0
  && webhookSecret.length > 0
  && paymentId.length > 0
  && customerId.length > 0
  && Number.isSafeInteger(amount) && amount > 0
  && /^[A-Z]{3}$/.test(currency);

function mandateCase(id: string): RecoveryCase {
  const at = new Date().toISOString();
  return addAttempt(
    createRecoveryCase(id, { customerId, subscriptionId: `${id}-subscription`, orderId: `${id}-order`, amount, currency, dueAt: at }, at),
    { id: `${id}:attempt:1`, providerPaymentId: paymentId, method: 'recurring_mandate', status: 'failed', occurredAt: at },
  );
}

describe.skipIf(!configured)('Razorpay Test Mode recurring retry proof', () => {
  it('charges the authorized mandate again and resolves a replayed action identity to the same payment', async () => {
    const provider = new RazorpayTestModeProvider({ keyId, keySecret, webhookSecret, recurringRetryEnabled: true, clock: new SystemClock() });
    const recoveryCase = mandateCase(`proof-${Date.now()}`);
    const action = { id: `${recoveryCase.id}:action:1`, kind: 'retry' as const, status: 'pending' as const, idempotencyKey: `${recoveryCase.id}:retry`, createdAt: recoveryCase.createdAt };

    const charged = await provider.submitRetry(recoveryCase, action);

    expect(charged.status).toBe('submitted');
    expect(charged.providerReference).toMatch(/^pay_/);

    // The same action identity must resolve to the charge Razorpay already holds rather than
    // making a second one. This is the invariant a duplicate webhook delivery depends on.
    const replayed = await provider.submitRetry(recoveryCase, action);

    expect(replayed.providerReference).toBe(charged.providerReference);
    expect(replayed.idempotent).toBe(true);
  }, 60_000);
});
