import { describe, expect, it } from 'vitest';
import type { AuditEvent, RecoveryCase } from '../src/domain.js';
import { FixtureDiagnosisEngine } from '../src/recovery.js';
import {
  EVALUATION_ARCHETYPES,
  generateEvaluationCases,
  runEvaluation,
  tallyRefusals,
  type EvaluationReport,
} from '../src/evaluation.js';

const SEED = 42;

async function runSeededBatch(count = 60, seed = SEED): Promise<EvaluationReport> {
  return runEvaluation(generateEvaluationCases(count, seed));
}

/** One audit event, carrying only the fields the refusal tally reads. */
function auditEvent(type: AuditEvent['type'], data: Record<string, unknown>): AuditEvent {
  return { id: `audit-${type}-${JSON.stringify(data)}`, caseId: 'case-1', type, actor: 'policy', at: '2026-01-01T00:00:00.000Z', explanation: type, data };
}

describe('seeded evaluation dataset', () => {
  it('generates a batch of at least 50 cases covering every scenario archetype', () => {
    const cases = generateEvaluationCases(60, SEED);
    expect(cases.length).toBe(60);
    expect(cases.length).toBeGreaterThanOrEqual(50);
    expect(new Set(cases.map((evaluationCase) => evaluationCase.archetype))).toEqual(new Set(EVALUATION_ARCHETYPES));
  });

  it('refuses a batch too small to cover its own archetypes', () => {
    expect(() => generateEvaluationCases(3, SEED)).toThrow(/at least/);
  });

  it('generates the same dataset for the same seed and a different one for another seed', () => {
    expect(generateEvaluationCases(60, SEED)).toEqual(generateEvaluationCases(60, SEED));
    expect(generateEvaluationCases(60, 43)).not.toEqual(generateEvaluationCases(60, SEED));
  });

  it('keeps the expected safe action and outcome out of the runtime signals the workflow reads', () => {
    for (const evaluationCase of generateEvaluationCases(60, SEED)) {
      const serializedSignals = JSON.stringify({ steps: evaluationCase.steps, simulator: evaluationCase.simulator });
      expect(serializedSignals).not.toContain(evaluationCase.expected.outcome);
      expect(serializedSignals).not.toContain(evaluationCase.archetype);
    }
  });

  it('covers duplicate, delayed, and contradictory deliveries', () => {
    const cases = generateEvaluationCases(60, SEED);
    const events = cases.flatMap((evaluationCase) => evaluationCase.steps.filter((step) => step.kind === 'event'));
    expect(events.some((step) => step.kind === 'event' && step.delivery === 'duplicate')).toBe(true);
    expect(events.some((step) => step.kind === 'event' && step.delivery === 'delayed')).toBe(true);
    expect(events.some((step) => step.kind === 'event' && step.delivery === 'contradictory')).toBe(true);
  });
});

describe('evaluation run', () => {
  it('produces identical totals for repeated runs of the same seed', async () => {
    const first = await runSeededBatch();
    const second = await runSeededBatch();
    expect(first.metrics).toEqual(second.metrics);
    expect(first.results.map((result) => result.outcome)).toEqual(second.results.map((result) => result.outcome));
  });

  it('labels its results synthetic and records the seed and versions it ran with', async () => {
    const { metrics } = await runSeededBatch();
    expect(metrics.synthetic).toBe(true);
    expect(metrics.seed).toBe(SEED);
    expect(metrics.policyVersion).toBe('policy-v1');
    expect(metrics.datasetVersion).toBeTruthy();
    expect(metrics.diagnosisModelVersion).toBeTruthy();
  });

  it('refuses to publish metrics for an empty batch', async () => {
    await expect(runEvaluation([])).rejects.toThrow(/at least one case/);
  });

  it('reaches the expected outcome for every generated case', async () => {
    const { metrics, results } = await runSeededBatch();
    const mismatched = results.filter((result) => !result.matchedExpectation);
    expect(mismatched.map((result) => `${result.caseId} ${result.archetype}: expected ${result.expected.outcome}, got ${result.outcome}`)).toEqual([]);
    expect(metrics.expectationMismatches).toBe(0);
  });

  it('reconciles published totals to individual case outcomes', async () => {
    const { metrics, results } = await runSeededBatch();
    expect(metrics.totalCases).toBe(results.length);
    expect(metrics.failedRenewalValue).toBe(results.reduce((sum, result) => sum + result.amountAtRisk, 0));
    expect(metrics.recoveredAmount).toBe(results.reduce((sum, result) => sum + result.recoveredAmount, 0));
    expect(metrics.unrecoveredAmount).toBe(metrics.failedRenewalValue - metrics.recoveredAmount);
    expect(metrics.recoveredCases).toBe(results.filter((result) => result.recoveredAmount > 0).length);
    expect(metrics.retryRecoveredCases).toBe(results.filter((result) => result.recoveryPath === 'retry').length);
    expect(metrics.fallbackRecoveredCases).toBe(results.filter((result) => result.recoveryPath === 'fallback_link').length);
    expect(metrics.escalatedCases).toBe(results.filter((result) => result.outcome === 'escalated').length);
    expect(metrics.exhaustedCases).toBe(results.filter((result) => result.outcome === 'exhausted').length);
    expect(metrics.stoppedCases).toBe(results.filter((result) => result.outcome === 'stopped').length);
    // Every recovered case is accounted for by exactly one attribution bucket.
    expect(metrics.recoveredCases).toBe(metrics.retryRecoveredCases + metrics.fallbackRecoveredCases);
    expect(metrics.recoveryRate).toBeCloseTo(metrics.recoveredCases / metrics.totalCases, 12);
  });

  it('reconciles every case result to the Recovery Case and its audit trail', async () => {
    const { results } = await runSeededBatch();
    for (const result of results) {
      const recoveryCase: RecoveryCase = result.recoveryCase;
      expect(result.caseId).toBe(recoveryCase.id);
      expect(result.amountAtRisk).toBe(recoveryCase.context.amount);
      expect(result.recoveredAmount).toBe(recoveryCase.recoveredAmount);
      expect(result.retryActions).toBe(recoveryCase.actions.filter((action) => action.kind === 'retry').length);
      expect(result.fallbackActions).toBe(recoveryCase.actions.filter((action) => action.kind === 'fallback_link').length);
      expect(result.retryActions).toBeLessThanOrEqual(1);
      expect(result.fallbackActions).toBeLessThanOrEqual(1);
      expect(result.providerOperations).toBeLessThanOrEqual(result.retryActions + result.fallbackActions);
      expect(result.auditEvents).toBe(recoveryCase.audit.length);
      const blocked = recoveryCase.audit.filter((event) => event.type === 'policy_blocked');
      expect(result.unsafeActionsPrevented + result.recommendationsRefused).toBe(blocked.length);
      expect(result.providerIneligibleRetries).toBe(recoveryCase.audit.filter((event) => event.type === 'retry_ineligible').length);
      expect(recoveryCase.audit.some((event) => event.type === 'case_opened')).toBe(true);
      if (result.recoveredAmount > 0) expect(recoveryCase.audit.some((event) => event.type === 'case_recovered')).toBe(true);
    }
  });

  it('counts recovered revenue only for a correlated success that followed an approved action', async () => {
    const { results } = await runSeededBatch();
    for (const result of results) {
      expect(result.recoveredAmount > 0).toBe(result.expected.recoversRevenue);
      if (result.recoveredAmount === 0) continue;
      expect(result.recoveredAmount).toBe(result.amountAtRisk);
      // The figure names the action that earned it, and the path agrees with what was persisted.
      expect(result.recoveryCase.recoveryAttribution).toBeDefined();
      expect(result.recoveryPath).toBe(result.recoveryCase.recoveryAttribution?.actionKind);
      const credited = result.recoveryCase.actions.find((action) => action.idempotencyKey === result.recoveryCase.recoveryAttribution?.idempotencyKey);
      expect(credited?.providerReference).toBe(result.recoveryCase.recoveryAttribution?.providerReference);
    }
    const preExisting = results.filter((result) => result.outcome === 'stopped');
    expect(preExisting.length).toBeGreaterThan(0);
    for (const result of preExisting) {
      expect(result.recoveredAmount).toBe(0);
      expect(result.recoveryPath).toBe('none');
      expect(result.recoveryCase.audit.some((event) => event.type === 'pre_existing_success')).toBe(true);
    }
  });

  it('credits a link the customer paid after it lapsed to that link', async () => {
    const { results } = await runSeededBatch();
    const late = results.filter((result) => result.archetype === 'late_success_after_exhaustion_recovered');
    expect(late.length).toBeGreaterThan(0);
    for (const result of late) {
      // The link expired and the case was exhausted before the money arrived. The action is gone,
      // but the payment still names it, so the renewal is recovered revenue with an owner.
      expect(result.recoveryCase.audit.some((event) => event.type === 'fallback_link_expired')).toBe(true);
      expect(result.recoveryPath).toBe('fallback_link');
      expect(result.recoveredAmount).toBe(result.amountAtRisk);
      expect(result.recoveryCase.recoveryAttribution?.providerReference).toBe(`sim_link_${result.caseId}`);
    }
  });

  it('reports prevented unsafe and duplicate actions', async () => {
    const { metrics, results } = await runSeededBatch();
    expect(metrics.unsafeActionsPrevented).toBe(results.reduce((sum, result) => sum + result.unsafeActionsPrevented, 0));
    expect(metrics.recommendationsRefused).toBe(results.reduce((sum, result) => sum + result.recommendationsRefused, 0));
    expect(metrics.recommendationsRefused).toBeGreaterThan(0);
    expect(metrics.providerIneligibleRetries).toBe(results.reduce((sum, result) => sum + result.providerIneligibleRetries, 0));
    expect(metrics.duplicateActionsPrevented).toBe(results.reduce((sum, result) => sum + result.duplicateActionsPrevented, 0));
    expect(metrics.duplicateEventsIgnored).toBe(results.reduce((sum, result) => sum + result.duplicateEventsIgnored, 0));
    expect(metrics.lateEventsIgnored).toBe(results.reduce((sum, result) => sum + result.lateEventsIgnored, 0));
    expect(metrics.duplicateActionsPrevented).toBeGreaterThan(0);
    expect(metrics.duplicateEventsIgnored).toBeGreaterThan(0);
    expect(metrics.lateEventsIgnored).toBeGreaterThan(0);
    // A case whose every recommendation policy refused must hold no money action at all. A case
    // that was merely refused one rung — an ineligible retry — may still take the next one.
    for (const result of results.filter((candidate) => candidate.recommendationsRefused > 0)) {
      expect(result.retryActions + result.fallbackActions).toBe(0);
    }
    // A case that never spent a rung cannot have prevented a duplicate: re-driving it is a no-op,
    // not a suppressed second charge.
    for (const result of results.filter((candidate) => candidate.retryActions + candidate.fallbackActions === 0)) {
      expect(result.duplicateActionsPrevented).toBe(0);
    }
    for (const result of results.filter((candidate) => candidate.duplicateActionsPrevented > 0)) {
      expect(result.retryActions + result.fallbackActions).toBeGreaterThan(0);
    }
  });

  it('separates a refused charge from a refused recommendation and a provider capability miss', () => {
    // Seed 42 contains no case where policy had to refuse a charge, so every batch assertion on
    // `unsafeActionsPrevented` is zero-valued. Without this, the counter could return a constant
    // 0 and ship as the merchant's "charges policy refused" tile with nothing to catch it.
    const audit = [
      auditEvent('policy_blocked', { action: 'retry' }),
      auditEvent('policy_blocked', { action: 'fallback_link' }),
      auditEvent('policy_blocked', { action: 'escalate' }),
      auditEvent('policy_blocked', { action: 'stop' }),
      auditEvent('retry_ineligible', {}),
      auditEvent('policy_allowed', { action: 'retry' }),
    ];

    expect(tallyRefusals(audit)).toEqual({
      unsafeActionsPrevented: 2,
      recommendationsRefused: 2,
      providerIneligibleRetries: 1,
    });
  });

  it('counts only refused money actions as unsafe actions prevented', async () => {
    const { results } = await runSeededBatch();

    // A diagnosis that recommends escalation proposes no money action, so policy refusing it
    // prevented nothing unsafe — it agreed. Counting those inflates the safety claim.
    for (const result of results) {
      const blocked = result.recoveryCase.audit.filter((event) => event.type === 'policy_blocked');
      const blockedMoneyActions = blocked.filter((event) => event.data.action === 'retry' || event.data.action === 'fallback_link');
      const ineligibleRetries = result.recoveryCase.audit.filter((event) => event.type === 'retry_ineligible');
      expect(result.unsafeActionsPrevented).toBe(blockedMoneyActions.length);
      expect(result.recommendationsRefused).toBe(blocked.length - blockedMoneyActions.length);
      expect(result.providerIneligibleRetries).toBe(ineligibleRetries.length);
    }
    // A retry the provider called ineligible is a capability miss, not a safety control: the loop
    // steps down and the customer may still be charged through the fallback link. Counting it as
    // an unsafe action prevented would claim a charge was stopped when money moved.
    for (const result of results.filter((candidate) => candidate.providerIneligibleRetries > 0)) {
      expect(result.fallbackActions).toBeGreaterThan(0);
    }
    // The hard-decline archetype is refused, but its own diagnosis asked to escalate.
    const hardDecline = results.filter((result) => result.archetype === 'hard_decline_escalated');
    expect(hardDecline.length).toBeGreaterThan(0);
    for (const result of hardDecline) {
      expect(result.unsafeActionsPrevented).toBe(0);
      expect(result.recommendationsRefused).toBeGreaterThan(0);
    }
  });

  it('scores the action policy authorized against the action ground truth calls safe', async () => {
    const { metrics, results } = await runSeededBatch();
    expect(metrics.safeActionMismatches).toBe(results.filter((result) => !result.safeActionMatched).length);
    expect(metrics.safeActionMismatches).toBeGreaterThan(0);
    // The loop may only deviate from the safe action when the provider signal misled its diagnosis.
    for (const result of results.filter((candidate) => !candidate.safeActionMatched)) {
      expect(result.diagnosisCorrect).toBe(false);
    }
    for (const result of results.filter((candidate) => candidate.safeActionMatched)) {
      expect(result.firstAuthorizedAction).toBe(result.expected.safeAction);
    }
  });

  it('measures diagnosis accuracy against ground truth rather than the prediction itself', async () => {
    const { metrics, results } = await runSeededBatch();
    const diagnosed = results.filter((result) => result.diagnosedCategory !== undefined);
    const correct = diagnosed.filter((result) => result.diagnosedCategory === result.expected.failureCategory);
    expect(metrics.diagnosedCases).toBe(diagnosed.length);
    expect(diagnosed.length).toBeLessThan(results.length);
    expect(metrics.diagnosisAccuracy).toBeCloseTo(correct.length / diagnosed.length, 12);
    expect(metrics.diagnosisAccuracy).toBeGreaterThan(0.5);
    // A dataset the predictor gets perfectly right would prove nothing about the metric.
    expect(metrics.diagnosisAccuracy).toBeLessThan(1);
  });

  it('scores whichever diagnosis engine the batch is given', async () => {
    // The fixture engine calls every failure transient, so it misses the hard declines on purpose.
    const { metrics } = await runEvaluation(generateEvaluationCases(60, SEED), { diagnosisEngine: new FixtureDiagnosisEngine() });
    const signal = await runSeededBatch();
    expect(metrics.diagnosisAccuracy).toBeLessThan(signal.metrics.diagnosisAccuracy);
    expect(metrics.diagnosedCases).toBeGreaterThan(0);
  });

  it('covers each recovery path and every terminal outcome', async () => {
    const { metrics } = await runSeededBatch();
    expect(metrics.retryRecoveredCases).toBeGreaterThan(0);
    expect(metrics.fallbackRecoveredCases).toBeGreaterThan(0);
    expect(metrics.escalatedCases).toBeGreaterThan(0);
    expect(metrics.exhaustedCases).toBeGreaterThan(0);
    expect(metrics.stoppedCases).toBeGreaterThan(0);
    expect(metrics.openCases).toBe(0);
  });

  /**
   * The published demo figures. They are quoted in the README, the PR, and the pitch, so a
   * behaviour change that moves them must fail here rather than silently invalidate what was
   * published. Update these numbers deliberately, together with whatever quotes them.
   */
  it('publishes the documented seed-42 headline figures', async () => {
    const { metrics } = await runSeededBatch(60, 42);
    expect(metrics).toMatchObject({
      totalCases: 60,
      failedRenewalValue: 313_818_200,
      recoveredAmount: 145_615_400,
      unrecoveredAmount: 168_202_800,
      recoveredCases: 28,
      retryRecoveredCases: 15,
      fallbackRecoveredCases: 13,
      escalatedCases: 16,
      exhaustedCases: 12,
      stoppedCases: 4,
      openCases: 0,
      diagnosedCases: 48,
      unsafeActionsPrevented: 0,
      recommendationsRefused: 8,
      providerIneligibleRetries: 4,
      duplicateActionsPrevented: 17,
      duplicateEventsIgnored: 45,
      lateEventsIgnored: 10,
      safeActionMismatches: 4,
      expectationMismatches: 0,
    });
    expect(metrics.diagnosisAccuracy).toBeCloseTo(44 / 48, 12);
  });

  it('runs on a controllable clock so link expiry is deterministic', async () => {
    const cases = generateEvaluationCases(60, SEED);
    const early = await runEvaluation(cases, { startedAt: '2026-01-01T00:00:00.000Z' });
    const late = await runEvaluation(cases, { startedAt: '2027-06-30T12:00:00.000Z' });
    expect(late.metrics).toEqual({ ...early.metrics, startedAt: late.metrics.startedAt });
    expect(early.metrics.startedAt).toBe('2026-01-01T00:00:00.000Z');
    // A link only lapses because the clock moved past its expiry, so every expiry proves the
    // controllable clock ran. Where nobody paid afterwards, the case must end exhausted.
    const lapsed = early.results.filter((result) => result.recoveryCase.audit.some((event) => event.type === 'fallback_link_expired'));
    expect(lapsed.length).toBeGreaterThan(0);
    for (const result of lapsed.filter((result) => result.recoveredAmount === 0)) expect(result.outcome).toBe('exhausted');
    expect(lapsed.filter((result) => result.recoveredAmount === 0).length).toBeGreaterThan(0);
  });

  it('rejects an unusable start timestamp instead of running on a broken clock', async () => {
    await expect(runEvaluation(generateEvaluationCases(60, SEED), { startedAt: 'not-a-timestamp' })).rejects.toThrow(/valid timestamp/);
  });
});
