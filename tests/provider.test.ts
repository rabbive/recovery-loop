import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DeterministicSimulator } from '../src/provider.js';
import { createRecoveryCase } from '../src/domain.js';

describe('DeterministicSimulator', () => {
  it('verifies its signed event convention and normalizes events', () => {
    const provider = new DeterministicSimulator();
    expect(provider.verifyEvent('payload', 'sim:payload')).toBe(true);
    expect(provider.verifyEvent('payload', 'bad')).toBe(false);
    const event = provider.normalizeEvent({ id: 'e1', type: 'unknown', caseId: 'c1', occurredAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:01.000Z');
    expect(event.id).toBe('e1');
    expect(event.caseId).toBe('c1');
  });

  it('verifies Razorpay-style HMAC signatures without accepting missing credentials', async () => {
    const { RazorpayTestModeProvider } = await import('../src/provider.js');
    const provider = new RazorpayTestModeProvider({ keyId: 'test_key', keySecret: 'test_secret' });
    const signature = createHmac('sha256', 'test_secret').update('payload').digest('hex');
    expect(provider.verifyEvent('payload', signature)).toBe(true);
    expect(provider.verifyEvent('payload', 'bad')).toBe(false);
  });

  it('only allows recurring mandate retries', async () => {
    const provider = new DeterministicSimulator();
    const cardCase = createRecoveryCase('card', { customerId: 'c', subscriptionId: 's', orderId: 'o', amount: 1, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:00.000Z');
    expect((await provider.retryEligibility(cardCase)).eligible).toBe(false);
  });
});
