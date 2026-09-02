import { describe, expect, it } from 'vitest';
import {
  addAction,
  addAttempt,
  appendAudit,
  canTransition,
  createRecoveryCase,
  InvalidCaseTransitionError,
  markRecovered,
  matchRecoveryAction,
  recoveryAttribution,
  withDiagnosis,
  withStatus,
} from '../src/domain.js';

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
    // Any status that could have authorized an action still reaches recovered, but a case that
    // never authorized one does not, and a recovered case never re-enters the loop.
    expect(canTransition('diagnosed', 'recovered')).toBe(true);
    expect(canTransition('at_risk', 'recovered')).toBe(false);
    const recovered = withStatus(createRecoveryCase('case', context, '2026-01-01T00:00:00.000Z'), 'diagnosed', '2026-01-01T00:00:01.000Z');
    expect(() => withStatus(recovered, 'retry_scheduled', '2026-01-01T00:00:02.000Z')).not.toThrow();
    expect(() => withStatus(withStatus(recovered, 'recovered', '2026-01-01T00:00:02.000Z'), 'retry_scheduled', '2026-01-01T00:00:03.000Z')).toThrow(InvalidCaseTransitionError);
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
    const first = appendAudit(initial, { type: 'case_opened', actor: 'system', at: '2026-01-01T00:00:01.000Z', explanation: 'first', data: { value: 1 } });
    const second = appendAudit(first, { type: 'policy_allowed', actor: 'policy', at: '2026-01-01T00:00:02.000Z', explanation: 'second', data: {} });
    expect(second.audit.map((event) => event.id)).toEqual(['case:audit:1', 'case:audit:2']);
    expect(second.audit[0]?.caseId).toBe('case');
    expect(Object.isFrozen(second.audit[0]?.data)).toBe(true);
  });

  it('refuses an empty case id and a due date the domain cannot attest to', () => {
    expect(() => createRecoveryCase('', context, '2026-01-01T00:00:00.000Z')).toThrow(/id is required/);
    expect(() => createRecoveryCase('case', { ...context, dueAt: 'not-a-timestamp' }, '2026-01-01T00:00:00.000Z')).toThrow(/dueAt/);
  });

  it('is idempotent over a repeated attempt and a repeated action identity', () => {
    const base = createRecoveryCase('case', context, '2026-01-01T00:00:00.000Z');
    const attempt = { id: 'attempt-1', providerPaymentId: 'pay_1', method: 'recurring_mandate' as const, status: 'failed' as const, occurredAt: '2026-01-01T00:00:01.000Z' };
    const withAttempt = addAttempt(base, attempt);
    expect(addAttempt(withAttempt, { ...attempt, id: 'attempt-1' })).toBe(withAttempt);
    const action = { id: 'act-1', kind: 'retry' as const, status: 'pending' as const, idempotencyKey: 'case:retry', createdAt: '2026-01-01T00:00:01.000Z' };
    const withAction = addAction(withAttempt, action, '2026-01-01T00:00:01.000Z');
    expect(addAction(withAction, { ...action, id: 'act-2' }, '2026-01-01T00:00:02.000Z')).toBe(withAction);
  });

  it('rejects a diagnosis that cannot transition the case or is not a valid confidence', () => {
    const recovered = withStatus(withStatus(createRecoveryCase('case', context, '2026-01-01T00:00:00.000Z'), 'diagnosed', '2026-01-01T00:00:00.000Z'), 'recovered', '2026-01-01T00:00:01.000Z', 'recovered');
    const diagnosis = { failureCategory: 'transient' as const, confidence: 0.9, evidence: ['e'], recommendedAction: 'retry' as const, explanation: 'x', modelVersion: 'v' };
    expect(() => withDiagnosis(recovered, diagnosis, '2026-01-01T00:00:02.000Z')).toThrow(InvalidCaseTransitionError);
    expect(() => withDiagnosis(createRecoveryCase('case', context, '2026-01-01T00:00:00.000Z'), { ...diagnosis, confidence: 1.5 }, '2026-01-01T00:00:02.000Z')).toThrow(/confidence/);
  });

  it('lets no action earn revenue that policy could not have authorized', () => {
    const base = createRecoveryCase('case', context, '2026-01-01T00:00:00.000Z');
    const event = { id: 'event-1', type: 'payment_succeeded' as const, caseId: 'case', providerPaymentId: 'pay_1', occurredAt: '2026-01-01T00:00:03.000Z', receivedAt: '2026-01-01T00:00:04.000Z', payload: {} };
    // A stop action carrying a reference a payment names is not money moving: policy only allows
    // it as a verdict, so correlation must refuse it rather than book the renewal as recovered.
    const stopped = withStatus(base, 'stopped', '2026-01-01T00:00:01.000Z', 'stopped');
    const withStop = addAction(stopped, { id: 'act-stop', kind: 'stop', status: 'submitted', idempotencyKey: 'case:stop', providerReference: 'pay_1', createdAt: '2026-01-01T00:00:02.000Z' }, '2026-01-01T00:00:02.000Z');
    expect(matchRecoveryAction(withStop, event)).toBeUndefined();
    expect(recoveryAttribution(withStop.actions[0]!, event)).toBeUndefined();
    // Unauthorized actions carry no provider reference, so a payment naming the idempotency key
    // still never correlates.
    const unauthorized = addAction(base, { id: 'act-retry', kind: 'retry', status: 'submitted', idempotencyKey: 'case:retry', createdAt: '2026-01-01T00:00:02.000Z' }, '2026-01-01T00:00:02.000Z');
    expect(matchRecoveryAction(unauthorized, { ...event, actionIdempotencyKey: 'case:retry' })).toBeUndefined();
    // An action whose reference matches a payment with no payment id is not reconcilable.
    const { providerPaymentId, ...paymentWithoutId } = event;
    void providerPaymentId;
    expect(recoveryAttribution(unauthorized.actions[0]!, paymentWithoutId)).toBeUndefined();
  });

  it('refuses to mark a case recovered from a status that cannot reach recovery', () => {
    const attribution = { actionId: 'a', actionKind: 'retry' as const, idempotencyKey: 'k', providerReference: 'r', providerPaymentId: 'p', eventId: 'e', occurredAt: '2026-01-01T00:00:03.000Z' };
    const atRisk = createRecoveryCase('case', context, '2026-01-01T00:00:00.000Z');
    expect(() => markRecovered(atRisk, attribution, '2026-01-01T00:00:02.000Z')).toThrow(InvalidCaseTransitionError);
    const diagnosed = withDiagnosis(atRisk, { failureCategory: 'transient', confidence: 0.9, evidence: ['e'], recommendedAction: 'retry', explanation: 'x', modelVersion: 'v' }, '2026-01-01T00:00:01.000Z');
    const recovered = markRecovered(diagnosed, attribution, '2026-01-01T00:00:02.000Z');
    expect(recovered.status).toBe('recovered');
    expect(recovered.recoveredAmount).toBe(context.amount);
    expect(recovered.recoveryAttribution).toEqual(attribution);
  });
});
