import { describe, expect, it } from 'vitest';
import {
  addAction,
  addAttempt,
  createRecoveryCase,
  updateAction,
  withDiagnosis,
  withStatus,
  type CaseStatus,
  type Diagnosis,
  type FailureCategory,
  type RecommendedAction,
  type RecoveryAction,
  type RecoveryCase,
} from '../src/domain.js';
import { DeterministicPolicy } from '../src/recovery.js';

const now = '2026-01-02T00:00:00.000Z';
const context = { customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z' };
const policy = new DeterministicPolicy();

function diagnosis(overrides: Partial<Diagnosis> = {}): Diagnosis {
  return { failureCategory: 'transient', confidence: 0.9, evidence: ['insufficient_funds'], recommendedAction: 'retry', explanation: 'Transient decline', modelVersion: 'test-v1', ...overrides };
}

function action(kind: RecoveryAction['kind'], overrides: Partial<RecoveryAction> = {}): RecoveryAction {
  return { id: `case-1:action:${kind}`, kind, status: 'succeeded', idempotencyKey: `case-1:${kind}`, createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

/** A case that has observed a failed recurring-mandate renewal and holds a diagnosis. */
function diagnosedCase(overrides: { actions?: readonly RecoveryAction[]; status?: CaseStatus; attempts?: boolean } = {}): RecoveryCase {
  let recoveryCase = createRecoveryCase('case-1', context, '2026-01-01T00:00:00.000Z');
  if (overrides.attempts !== false) {
    recoveryCase = addAttempt(recoveryCase, { id: 'case-1:attempt:1', providerPaymentId: 'pay_1', method: 'recurring_mandate', status: 'failed', occurredAt: '2026-01-01T00:00:00.000Z' });
  }
  recoveryCase = withDiagnosis(recoveryCase, diagnosis(), '2026-01-01T00:00:01.000Z');
  for (const recoveryAction of overrides.actions ?? []) recoveryCase = addAction(recoveryCase, recoveryAction, '2026-01-01T00:00:02.000Z');
  if (overrides.status === undefined) return recoveryCase;
  // `exhausted` is only reachable once a bounded action has been offered.
  const viaFallback = overrides.status === 'exhausted' ? withStatus(recoveryCase, 'fallback_link_available', '2026-01-01T00:00:03.000Z') : recoveryCase;
  return withStatus(viaFallback, overrides.status, '2026-01-01T00:00:04.000Z');
}

describe('DeterministicPolicy rule matrix', () => {
  it('refuses the recommended money action itself when the case is already terminal', () => {
    // The reason a charge is refused has to name the charge: a merchant reading "policy refused
    // a retry" is reading a safety control that fired, not a case that was routed to a human.
    const terminal = diagnosedCase({ status: 'escalated' });

    const decision = policy.decide(terminal, diagnosis({ recommendedAction: 'retry' }), now);

    expect(decision).toMatchObject({ action: 'retry', allowed: false, reason: 'Case is terminal' });
  });

  const unsafeCategories: readonly FailureCategory[] = ['hard_decline', 'cancelled', 'dispute', 'unknown', 'unsupported'];

  it.each(unsafeCategories)('escalates %s rather than automating it', (failureCategory) => {
    const decision = policy.decide(diagnosedCase(), diagnosis({ failureCategory }), now);

    expect(decision.allowed).toBe(false);
    expect(decision.action).toBe('escalate');
    expect(decision.policyVersion).toBe('policy-v1');
  });

  it.each([
    ['transient', 'retry', true],
    ['expired', 'fallback_link', true],
  ] as const)('allows a %s failure to proceed with %s', (failureCategory, recommendedAction, allowed) => {
    const decision = policy.decide(diagnosedCase(), diagnosis({ failureCategory, recommendedAction }), now);

    expect(decision.allowed).toBe(allowed);
    expect(decision.action).toBe(recommendedAction);
  });

  it.each([0, 0.74])('escalates a diagnosis whose confidence is %s', (confidence) => {
    const decision = policy.decide(diagnosedCase(), diagnosis({ confidence }), now);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/confidence/i);
  });

  it('allows a diagnosis exactly at the confidence threshold', () => {
    expect(policy.decide(diagnosedCase(), diagnosis({ confidence: 0.75 }), now).allowed).toBe(true);
  });

  it.each(['retry', 'fallback_link'] as const)('permits only one %s per case', (kind) => {
    const decision = policy.decide(diagnosedCase({ actions: [action(kind)] }), diagnosis({ recommendedAction: kind, failureCategory: kind === 'retry' ? 'transient' : 'expired' }), now);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/limit/i);
  });

  it.each(['recovered', 'escalated', 'exhausted', 'stopped'] as const)('authorizes nothing on a %s case', (status) => {
    const decision = policy.decide(diagnosedCase({ status }), diagnosis(), now);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/terminal/i);
  });

  it.each(['stop', 'escalate'] as const)('never turns a %s recommendation into a money action', (recommendedAction: RecommendedAction) => {
    const decision = policy.decide(diagnosedCase(), diagnosis({ recommendedAction }), now);

    expect(decision.allowed).toBe(false);
    expect(decision.action).toBe(recommendedAction);
  });

  describe('context integrity', () => {
    it('refuses to authorize money for a case with no observed failed attempt', () => {
      const decision = policy.decide(diagnosedCase({ attempts: false }), diagnosis(), now);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/failed payment attempt/i);
    });

    it.each([
      ['amount', { amount: 0 }],
      ['amount', { amount: -1200 }],
      ['amount', { amount: 12.5 }],
      ['currency', { currency: 'inr' }],
      ['currency', { currency: 'RUPEE' }],
    ])('refuses to authorize money when the renewal %s is not intact', (_field, corruption) => {
      // Rehydrating a case from storage can surface a context the aggregate never validated.
      const corrupted = { ...diagnosedCase(), context: { ...context, ...corruption } } as RecoveryCase;

      const decision = policy.decide(corrupted, diagnosis(), now);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/renewal context/i);
    });

    it('refuses to authorize a second collection once the renewal is already paid', () => {
      const paid = { ...diagnosedCase(), recoveredAmount: 1200 } as RecoveryCase;

      const decision = policy.decide(paid, diagnosis(), now);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/already recovered/i);
    });
  });

  describe('fallback-link expiry', () => {
    it('blocks a new action while an unexpired fallback link is still live', () => {
      const live = diagnosedCase({ actions: [action('fallback_link', { status: 'submitted', expiresAt: '2026-01-03T00:00:00.000Z' })] });

      const decision = policy.decide(live, diagnosis({ failureCategory: 'expired', recommendedAction: 'fallback_link' }), now);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/still live/i);
    });

    it('treats a lapsed fallback link as a spent action rather than a live one', () => {
      let lapsed = diagnosedCase({ actions: [action('fallback_link', { status: 'submitted', expiresAt: '2026-01-01T12:00:00.000Z' })] });
      lapsed = updateAction(lapsed, 'case-1:fallback_link', { status: 'submitted' }, now);

      const decision = policy.decide(lapsed, diagnosis({ failureCategory: 'expired', recommendedAction: 'fallback_link' }), now);

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/limit/i);
    });
  });
});
