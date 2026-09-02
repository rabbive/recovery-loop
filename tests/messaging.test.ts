import { describe, expect, it } from 'vitest';
import { fallbackRecoveryMessage } from '../src/messaging.js';
import type { RecoveryAction, RecoveryCase } from '../src/domain.js';

const now = '2026-01-01T00:00:00.000Z';
const context = { customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 129900, currency: 'INR', dueAt: '2025-12-31T00:00:00.000Z' };

function link(overrides: Partial<RecoveryAction> = {}): RecoveryAction {
  return { id: 'case-1:action:1', kind: 'fallback_link', status: 'succeeded', idempotencyKey: 'case-1:fallback_link:1', createdAt: now, providerReference: 'plink_test_1', expiresAt: '2026-01-02T00:00:00.000Z', ...overrides };
}

/** The provider refused the link, so there is no reference to send a customer to. */
function unresolvedLink(): RecoveryAction {
  return { id: 'case-1:action:1', kind: 'fallback_link', status: 'failed', idempotencyKey: 'case-1:fallback_link:1', createdAt: now };
}

function recoveryCase(overrides: Partial<RecoveryCase> = {}): RecoveryCase {
  return {
    id: 'case-1', context, status: 'fallback_link_available', createdAt: now, updatedAt: now,
    attempts: [{ id: 'attempt-1', providerPaymentId: 'pay_secret_1', method: 'recurring_mandate', status: 'failed', failureCode: 'insufficient_funds', occurredAt: now }],
    events: [], decisions: [], actions: [link()], audit: [], recoveredAmount: 0, ...overrides,
  };
}

describe('fallbackRecoveryMessage', () => {
  it('previews the renewal, the amount, the link reference, and the expiry', () => {
    const preview = fallbackRecoveryMessage(recoveryCase(), now);

    expect(preview).toMatchObject({
      customerId: 'customer-1',
      linkReference: 'plink_test_1',
      expiresAt: '2026-01-02T00:00:00.000Z',
      expired: false,
      // The MVP previews the message; it integrates no email, SMS, WhatsApp, or voice provider.
      deliverable: false,
    });
    expect(preview?.subject).toContain('subscription-1');
    expect(preview?.body).toContain('INR 1299.00');
    expect(preview?.body).toContain('2026-01-02T00:00:00.000Z');
  });

  it('carries no payment credentials, provider payment ids, or failure telemetry', () => {
    const preview = fallbackRecoveryMessage(recoveryCase(), now);

    const rendered = `${preview?.subject} ${preview?.body}`;
    expect(rendered).not.toContain('pay_secret_1');
    expect(rendered).not.toContain('insufficient_funds');
  });

  it('offers nothing when no fallback link was created', () => {
    expect(fallbackRecoveryMessage(recoveryCase({ actions: [] }), now)).toBeUndefined();
  });

  it('offers nothing for a fallback link the provider never created', () => {
    expect(fallbackRecoveryMessage(recoveryCase({ actions: [unresolvedLink()] }), now)).toBeUndefined();
  });

  it('offers nothing while the link is still awaiting the provider acknowledgement', () => {
    // A submitted-but-unacknowledged link has an expiry the provider may not honour yet.
    expect(fallbackRecoveryMessage(recoveryCase({ actions: [link({ status: 'pending' })] }), now)).toBeUndefined();
  });

  it('offers nothing once the renewal is paid, so a paid customer is never contacted again', () => {
    const paid = recoveryCase({ status: 'recovered', outcome: 'recovered', recoveredAmount: 129900 });

    expect(fallbackRecoveryMessage(paid, now)).toBeUndefined();
  });

  it('offers nothing once a payment attempt has succeeded, however the case was settled', () => {
    // The renewal was paid outside the loop, so the case stood down to `stopped` and never
    // reached `recovered` — asking this customer to pay the link would collect it twice.
    const stoodDown = recoveryCase({
      status: 'stopped',
      outcome: 'stopped',
      attempts: [{ id: 'attempt-2', providerPaymentId: 'pay_secret_2', method: 'recurring_mandate', status: 'succeeded', occurredAt: now }],
    });

    expect(fallbackRecoveryMessage(stoodDown, now)).toBeUndefined();
  });

  it('offers nothing for a case an operator stopped or escalated', () => {
    expect(fallbackRecoveryMessage(recoveryCase({ status: 'stopped', outcome: 'stopped' }), now)).toBeUndefined();
    expect(fallbackRecoveryMessage(recoveryCase({ status: 'escalated', outcome: 'escalated' }), now)).toBeUndefined();
  });

  it('offers nothing for a link with no recorded expiry, which is not a link policy treats as live', () => {
    const noExpiry = recoveryCase({ actions: [{ id: 'case-1:action:1', kind: 'fallback_link', status: 'succeeded', idempotencyKey: 'case-1:fallback_link:1', createdAt: now, providerReference: 'plink_test_1' }] });

    expect(fallbackRecoveryMessage(noExpiry, now)).toBeUndefined();
  });

  it('marks a lapsed link expired rather than previewing a link that no longer works', () => {
    const preview = fallbackRecoveryMessage(recoveryCase(), '2026-01-03T00:00:00.000Z');

    expect(preview).toMatchObject({ expired: true, deliverable: false });
    expect(preview?.body).toContain('expired');
  });

  it('preserves the renewal amount and currency exactly, since a recovery may not alter the purchase', () => {
    const preview = fallbackRecoveryMessage(recoveryCase({ context: { ...context, amount: 1, currency: 'USD' } }), now);

    expect(preview?.body).toContain('USD 0.01');
  });
});
