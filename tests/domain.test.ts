import { describe, expect, it } from 'vitest';
import { appendAudit, canTransition, createRecoveryCase, InvalidCaseTransitionError, withStatus } from '../src/domain.js';

describe('Recovery Case aggregate', () => {
  const context = { customerId: 'c', subscriptionId: 's', orderId: 'o', amount: 1000, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z' };

  it('validates and freezes the immutable renewal context', () => {
    const recoveryCase = createRecoveryCase('case', context, '2026-01-01T00:00:00.000Z');
    expect(Object.isFrozen(recoveryCase.context)).toBe(true);
    expect(() => createRecoveryCase('bad', { ...context, amount: 0 }, recoveryCase.createdAt)).toThrow(/amount/);
    expect(() => createRecoveryCase('bad', { ...context, currency: 'inr' }, recoveryCase.createdAt)).toThrow(/currency/);
  });

  it('enforces the lifecycle transition table', () => {
    expect(canTransition('at_risk', 'diagnosed')).toBe(true);
    expect(canTransition('recovered', 'escalated')).toBe(false);
    const recovered = withStatus(createRecoveryCase('case', context, '2026-01-01T00:00:00.000Z'), 'diagnosed', '2026-01-01T00:00:01.000Z');
    expect(() => withStatus(recovered, 'recovered', '2026-01-01T00:00:02.000Z')).toThrow(InvalidCaseTransitionError);
  });

  it('lets an escalated case still reconcile a real payment success', () => {
    expect(canTransition('escalated', 'recovered')).toBe(true);
    expect(canTransition('escalated', 'retry_scheduled')).toBe(false);
    expect(canTransition('exhausted', 'recovered')).toBe(true);
    expect(canTransition('recovered', 'escalated')).toBe(false);
    expect(canTransition('stopped', 'recovered')).toBe(false);
  });

  it('assigns stable append-only audit identities', () => {
    const initial = createRecoveryCase('case', context, '2026-01-01T00:00:00.000Z');
    const first = appendAudit(initial, { type: 'one', actor: 'system', at: '2026-01-01T00:00:01.000Z', explanation: 'first', data: { value: 1 } });
    const second = appendAudit(first, { type: 'two', actor: 'policy', at: '2026-01-01T00:00:02.000Z', explanation: 'second', data: {} });
    expect(second.audit.map((event) => event.id)).toEqual(['case:audit:1', 'case:audit:2']);
    expect(second.audit[0]?.caseId).toBe('case');
    expect(Object.isFrozen(second.audit[0]?.data)).toBe(true);
  });
});
