import { describe, expect, it } from 'vitest';
import type { RecoveryCase } from '../src/domain.js';
import { FixtureDiagnosisEngine } from '../src/recovery.js';
import {
  EVALUATION_ARCHETYPES,
  generateEvaluationCases,
  runEvaluation,
  type EvaluationReport,
} from '../src/evaluation.js';

const SEED = 42;

async function runSeededBatch(count = 60, seed = SEED): Promise<EvaluationReport> {
  return runEvaluation(generateEvaluationCases(count, seed));
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
    expect(metrics.unattributedRecoveredCases).toBe(results.filter((result) => result.outcome === 'recovered_unattributed').length);
    expect(metrics.escalatedCases).toBe(results.filter((result) => result.outcome === 'escalated').length);
    expect(metrics.exhaustedCases).toBe(results.filter((result) => result.outcome === 'exhausted').length);
    expect(metrics.stoppedCases).toBe(results.filter((result) => result.outcome === 'stopped').length);
    // Every recovered case is accounted for by exactly one attribution bucket.
    expect(metrics.recoveredCases).toBe(metrics.retryRecoveredCases + metrics.fallbackRecoveredCases + metrics.unattributedRecoveredCases);
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
      expect(result.unsafeActionsPrevented).toBe(recoveryCase.audit.filter((event) => event.type === 'policy_blocked').length);
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
      // Something policy authorized preceded the success, even when no surviving action can be credited.
      expect(result.recoveryCase.actions.length).toBeGreaterThan(0);
    }
    const preExisting = results.filter((result) => result.outcome === 'stopped');
    expect(preExisting.length).toBeGreaterThan(0);
    for (const result of preExisting) {
      expect(result.recoveredAmount).toBe(0);
      expect(result.recoveryPath).toBe('none');
      expect(result.recoveryCase.audit.some((event) => event.type === 'pre_existing_success')).toBe(true);
    }
  });

  it('leaves a recovery no surviving action can be credited with unattributed', async () => {
    const { metrics, results } = await runSeededBatch();
    const unattributed = results.filter((result) => result.outcome === 'recovered_unattributed');
    expect(metrics.unattributedRecoveredCases).toBe(unattributed.length);
    expect(unattributed.length).toBeGreaterThan(0);
    for (const result of unattributed) {
      expect(result.recoveredAmount).toBe(result.amountAtRisk);
      expect(result.recoveryPath).toBe('none');
      expect(result.recoveryCase.actions.every((action) => action.status === 'failed')).toBe(true);
    }
  });

  it('reports prevented unsafe and duplicate actions', async () => {
    const { metrics, results } = await runSeededBatch();
    expect(metrics.unsafeActionsPrevented).toBe(results.reduce((sum, result) => sum + result.unsafeActionsPrevented, 0));
    expect(metrics.duplicateActionsPrevented).toBe(results.reduce((sum, result) => sum + result.duplicateActionsPrevented, 0));
    expect(metrics.duplicateEventsIgnored).toBe(results.reduce((sum, result) => sum + result.duplicateEventsIgnored, 0));
    expect(metrics.lateEventsIgnored).toBe(results.reduce((sum, result) => sum + result.lateEventsIgnored, 0));
    expect(metrics.unsafeActionsPrevented).toBeGreaterThan(0);
    expect(metrics.duplicateActionsPrevented).toBeGreaterThan(0);
    expect(metrics.duplicateEventsIgnored).toBeGreaterThan(0);
    expect(metrics.lateEventsIgnored).toBeGreaterThan(0);
    // Every case that policy refused must hold no money action at all.
    for (const result of results.filter((candidate) => candidate.unsafeActionsPrevented > 0)) {
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
      fallbackRecoveredCases: 9,
      unattributedRecoveredCases: 4,
      escalatedCases: 16,
      exhaustedCases: 12,
      stoppedCases: 4,
      openCases: 0,
      diagnosedCases: 48,
      unsafeActionsPrevented: 8,
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
    const lapsed = early.results.filter((result) => result.recoveryCase.audit.some((event) => event.type === 'fallback_link_expired'));
    expect(lapsed.length).toBeGreaterThan(0);
    for (const result of lapsed) expect(result.outcome).toBe('exhausted');
  });

  it('rejects an unusable start timestamp instead of running on a broken clock', async () => {
    await expect(runEvaluation(generateEvaluationCases(60, SEED), { startedAt: 'not-a-timestamp' })).rejects.toThrow(/valid timestamp/);
  });
});
