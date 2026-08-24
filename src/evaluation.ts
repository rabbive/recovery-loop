import { DeterministicSimulator, FixedClock, type SimulatorScenario } from './provider.js';
import { FixtureDiagnosisEngine, DeterministicPolicy, InMemoryRecoveryStore, RecoveryWorkflow } from './recovery.js';
import type { Diagnosis, RenewalContext } from './domain.js';

export interface EvaluationCase {
  readonly id: string;
  readonly context: RenewalContext;
  readonly scenario: SimulatorScenario;
  readonly diagnosis: Diagnosis;
  readonly expected: 'retry_recovered' | 'fallback_recovered' | 'escalated' | 'exhausted';
}

export interface EvaluationMetrics {
  readonly totalCases: number;
  readonly revenueAtRisk: number;
  readonly recoveredAmount: number;
  readonly recoveryRate: number;
  readonly retryRecoveryRate: number;
  readonly fallbackRecoveryRate: number;
  readonly escalationRate: number;
  readonly exhaustedRate: number;
  readonly diagnosisAccuracy: number;
  readonly unsafeActionsPrevented: number;
  readonly duplicateActionsPrevented: number;
  readonly cases: readonly EvaluationCase[];
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

export function generateEvaluationCases(count = 60, seed = 42): EvaluationCase[] {
  const random = seededRandom(seed);
  return Array.from({ length: count }, (_, index) => {
    const id = `eval-${index + 1}`;
    const amount = 1000 + Math.floor(random() * 9000);
    const category = index % 10 === 0 ? 'hard_decline' : index % 11 === 0 ? 'low_confidence' : 'transient';
    const retry = category === 'hard_decline' ? 'unsupported' : index % 4 === 0 ? 'failure' : 'success';
    const fallback = index % 3 === 0 ? 'success' : 'failure';
    const expected = category !== 'transient'
      ? 'escalated'
      : retry === 'success'
        ? 'retry_recovered'
        : fallback === 'success'
          ? 'fallback_recovered'
          : 'exhausted';
    return {
      id,
      context: {
        customerId: `customer-${index + 1}`,
        subscriptionId: `subscription-${index + 1}`,
        orderId: `order-${index + 1}`,
        amount,
        currency: 'INR',
        dueAt: '2026-01-01T00:00:00.000Z',
      },
      scenario: { retry, fallback, diagnosis: category === 'hard_decline' ? 'hard_decline' : category === 'low_confidence' ? 'low_confidence' : 'transient' },
      diagnosis: {
        failureCategory: category === 'hard_decline' ? 'hard_decline' : 'transient',
        confidence: category === 'low_confidence' ? 0.4 : 0.95,
        evidence: [`failure-${index + 1}`],
        recommendedAction: 'retry',
        explanation: category === 'hard_decline' ? 'The provider reported a hard decline.' : 'The provider reported a recoverable renewal failure.',
        modelVersion: 'synthetic-v1',
      },
      expected,
    };
  });
}

export function runEvaluation(cases = generateEvaluationCases()): EvaluationMetrics {
  const clock = new FixedClock('2026-01-01T00:00:00.000Z');
  let revenueAtRisk = 0;
  let recoveredAmount = 0;
  let retryRecovered = 0;
  let fallbackRecovered = 0;
  let escalated = 0;
  let exhausted = 0;
  let diagnosisCorrect = 0;
  let unsafeActionsPrevented = 0;
  let duplicateActionsPrevented = 0;

  for (const evaluationCase of cases) {
    const store = new InMemoryRecoveryStore();
    const provider = new DeterministicSimulator(new Map([[evaluationCase.id, evaluationCase.scenario]]));
    const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(new Map([[evaluationCase.id, evaluationCase.diagnosis]])), new DeterministicPolicy(), clock);
    let current = workflow.openCase(evaluationCase.id, evaluationCase.context);
    revenueAtRisk += evaluationCase.context.amount;
    current = workflow.ingestEvent(provider.normalizeEvent({ id: `${evaluationCase.id}:failed`, type: 'payment_failed', caseId: evaluationCase.id, providerPaymentId: `${evaluationCase.id}:payment`, occurredAt: clock.now().toISOString(), payload: { method: 'recurring_mandate', failureCode: 'temporary' } }, clock.now().toISOString()));
    current = workflow.runDiagnosis(evaluationCase.id);
    if (current.diagnosis?.failureCategory === evaluationCase.diagnosis.failureCategory && current.diagnosis.confidence === evaluationCase.diagnosis.confidence) diagnosisCorrect += 1;
    current = workflow.authorize(evaluationCase.id);
    if (evaluationCase.expected === 'escalated') {
      if (current.status === 'escalated') escalated += 1;
      unsafeActionsPrevented += current.actions.length === 0 ? 1 : 0;
      continue;
    }
    current = workflow.executePending(evaluationCase.id);
    if (evaluationCase.expected === 'retry_recovered') {
      const success = provider.normalizeEvent({ id: `${evaluationCase.id}:success`, type: 'payment_succeeded', caseId: evaluationCase.id, occurredAt: clock.now().toISOString(), payload: {} }, clock.now().toISOString());
      current = workflow.ingestEvent(success);
      if (current.status === 'recovered') { recoveredAmount += current.recoveredAmount; retryRecovered += 1; }
    } else {
      // A failed retry installs the bounded fallback-link diagnosis; preserve it rather than asking the model to re-recommend retry.
      current = workflow.authorize(evaluationCase.id);
      current = workflow.executePending(evaluationCase.id);
      if (evaluationCase.expected === 'fallback_recovered') {
        const success = provider.normalizeEvent({ id: `${evaluationCase.id}:fallback-success`, type: 'payment_succeeded', caseId: evaluationCase.id, occurredAt: clock.now().toISOString(), payload: {} }, clock.now().toISOString());
        current = workflow.ingestEvent(success);
        if (current.status === 'recovered') { recoveredAmount += current.recoveredAmount; fallbackRecovered += 1; }
      } else if (current.status === 'exhausted') exhausted += 1;
    }
    const before = provider.calls.length;
    workflow.executePending(evaluationCase.id);
    duplicateActionsPrevented += provider.calls.length === before ? 1 : 0;
  }

  const totalCases = cases.length;
  return {
    totalCases,
    revenueAtRisk,
    recoveredAmount,
    recoveryRate: totalCases === 0 ? 0 : (retryRecovered + fallbackRecovered) / totalCases,
    retryRecoveryRate: totalCases === 0 ? 0 : retryRecovered / totalCases,
    fallbackRecoveryRate: totalCases === 0 ? 0 : fallbackRecovered / totalCases,
    escalationRate: totalCases === 0 ? 0 : escalated / totalCases,
    exhaustedRate: totalCases === 0 ? 0 : exhausted / totalCases,
    diagnosisAccuracy: totalCases === 0 ? 0 : diagnosisCorrect / totalCases,
    unsafeActionsPrevented,
    duplicateActionsPrevented,
    cases,
  };
}
