import { DiagnosisUnavailableError, type DiagnosisEngine } from './diagnosis.js';
import type { Diagnosis, FailureCategory, ProviderEvent, RecoveryCase, RenewalContext } from './domain.js';
import { DeterministicSimulator, FixedClock, type SimulatorScenario } from './provider.js';
import { DeterministicPolicy, InMemoryRecoveryStore, POLICY_VERSION, RecoveryWorkflow } from './recovery.js';

/**
 * The reproducible synthetic batch. Nothing here runs against a live provider: the deterministic
 * simulator answers every money operation, and the diagnosis engine below predicts from the same
 * case signals the model would see. Ground truth (`EvaluationExpectation`) is carried beside each
 * case and never reaches the workflow, so a run measures the loop rather than restating the answer.
 *
 * Every provider operation goes through `RecoveryWorkflow`, so the batch measures the loop the
 * product ships rather than the simulator's own memory of an action identity.
 */

export const DATASET_VERSION = 'evaluation-dataset-v1';
export const DIAGNOSIS_MODEL_VERSION = 'evaluation-signal-v1';
const DEFAULT_STARTED_AT = '2026-01-01T00:00:00.000Z';
/** Every step consumes a second of the controllable clock so audit timestamps stay ordered. */
const STEP_TICK_MILLISECONDS = 1_000;
/** Longer than the simulator's fallback-link TTL, so a lapsed link really is past its expiry. */
const BEYOND_LINK_EXPIRY_MILLISECONDS = 25 * 60 * 60 * 1000;

/** Provider failure codes the seeded dataset delivers. The engine below predicts from these alone. */
const FAILURE_CODES = {
  temporary: 'temporary_decline',
  insufficientFunds: 'insufficient_funds',
  hardDecline: 'card_declined',
  ambiguous: 'issuer_unavailable',
  unparseable: 'unparseable_gateway_blob',
} as const;

export type EvaluationOutcome =
  | 'recovered_by_retry'
  | 'recovered_by_fallback'
  /**
   * The renewal was collected after approved actions, but none of them is still standing, so no
   * single action can be credited. It is recovered revenue and deliberately left unattributed.
   */
  | 'recovered_unattributed'
  | 'escalated'
  | 'exhausted'
  | 'stopped'
  /** The batch left the case unresolved, which is a failure of the loop rather than an outcome. */
  | 'open';

export type RecoveryPath = 'retry' | 'fallback_link' | 'none';

/** How a delivery relates to the rest of the case, so reliability coverage is inspectable. */
export type EventDelivery = 'first' | 'duplicate' | 'delayed' | 'contradictory';

export interface EvaluationEventStep {
  readonly kind: 'event';
  readonly delivery: EventDelivery;
  /** Provider event identity. A duplicate delivery reuses an earlier id so ingestion must dedupe it. */
  readonly id: string;
  readonly type: ProviderEvent['type'];
  readonly providerPaymentId?: string;
  /** Offset from the case's start. A delayed delivery carries an earlier offset than the step before it. */
  readonly occurredOffsetMilliseconds: number;
  readonly payload?: Readonly<Record<string, unknown>>;
}

export type EvaluationStep =
  | EvaluationEventStep
  /** Carry the case to its next resting point, exactly as the webhook boundary does. */
  | { readonly kind: 'drive' }
  | { readonly kind: 'advance'; readonly milliseconds: number }
  | { readonly kind: 'expire' }
  /** Re-drive the case through the workflow, standing in for a redelivered or retried request. */
  | { readonly kind: 'replay' };

/**
 * Ground truth for one case: what the failure really was, which action would have been safe given
 * that truth, and how the case should end. Recorded beside the case, never handed to the workflow.
 */
export interface EvaluationExpectation {
  readonly failureCategory: FailureCategory;
  readonly safeAction: RecoveryPath;
  readonly outcome: EvaluationOutcome;
  readonly recoversRevenue: boolean;
}

interface ArchetypeDefinition {
  readonly simulator: SimulatorScenario;
  readonly expected: EvaluationExpectation;
  readonly steps: (id: string) => readonly EvaluationStep[];
}

function failedEvent(id: string, options: { readonly method: string; readonly failureCode: string }): EvaluationEventStep {
  return {
    kind: 'event',
    delivery: 'first',
    id: `${id}:failed`,
    type: 'payment_failed',
    providerPaymentId: `${id}:payment`,
    occurredOffsetMilliseconds: 0,
    payload: { method: options.method, failureCode: options.failureCode },
  };
}

/** The same delivery again. Provider event identity, not delivery order, decides what may change. */
function duplicateOf(step: EvaluationEventStep, occurredOffsetMilliseconds: number): EvaluationEventStep {
  return { ...step, delivery: 'duplicate', occurredOffsetMilliseconds };
}

function succeededEvent(id: string, occurredOffsetMilliseconds: number, suffix = 'succeeded'): EvaluationEventStep {
  return {
    kind: 'event',
    delivery: 'first',
    id: `${id}:${suffix}`,
    type: 'payment_succeeded',
    providerPaymentId: `${id}:recovery-payment`,
    occurredOffsetMilliseconds,
    payload: { method: 'recurring_mandate' },
  };
}

/** The mandate failure a case opens on, delivered once and then redelivered. */
function mandateFailureWithRedelivery(id: string, failureCode: string = FAILURE_CODES.temporary): readonly EvaluationStep[] {
  const failure = failedEvent(id, { method: 'recurring_mandate', failureCode });
  return [failure, duplicateOf(failure, 500)];
}

/**
 * The seeded scenarios. Each entry owns its simulator behaviour, its ground truth, and the delivery
 * script the workflow sees, so adding a scenario is one edit. Nothing in a script names its
 * archetype or expected outcome: the workflow only ever reads provider deliveries.
 */
const ARCHETYPE_DEFINITIONS = {
  transient_retry_recovered: {
    simulator: { retry: 'success', fallback: 'success', diagnosis: 'transient' },
    expected: { failureCategory: 'transient', safeAction: 'retry', outcome: 'recovered_by_retry', recoversRevenue: true },
    steps: (id) => [...mandateFailureWithRedelivery(id), { kind: 'drive' }, { kind: 'replay' }, succeededEvent(id, 60_000), { kind: 'drive' }],
  },
  duplicate_success_delivery_recovered: {
    simulator: { retry: 'success', fallback: 'success', diagnosis: 'transient' },
    expected: { failureCategory: 'transient', safeAction: 'retry', outcome: 'recovered_by_retry', recoversRevenue: true },
    steps: (id) => {
      const success = succeededEvent(id, 60_000);
      return [...mandateFailureWithRedelivery(id), { kind: 'drive' }, success, duplicateOf(success, 61_000), { kind: 'drive' }];
    },
  },
  delayed_contradictory_events_recovered: {
    simulator: { retry: 'success', fallback: 'success', diagnosis: 'transient' },
    expected: { failureCategory: 'transient', safeAction: 'retry', outcome: 'recovered_by_retry', recoversRevenue: true },
    steps: (id) => [
      ...mandateFailureWithRedelivery(id),
      { kind: 'drive' },
      succeededEvent(id, 60_000),
      // A failure that was in flight while the renewal was collected, and a dispute signal that
      // contradicts the settled outcome. Neither may re-open a recovered case.
      { kind: 'event', delivery: 'delayed', id: `${id}:late-failed`, type: 'payment_failed', providerPaymentId: `${id}:payment`, occurredOffsetMilliseconds: 30_000, payload: { method: 'recurring_mandate', failureCode: FAILURE_CODES.temporary } },
      { kind: 'event', delivery: 'contradictory', id: `${id}:dispute`, type: 'dispute_opened', occurredOffsetMilliseconds: 90_000, payload: {} },
      { kind: 'drive' },
    ],
  },
  retry_failed_fallback_recovered: {
    simulator: { retry: 'failure', fallback: 'success', diagnosis: 'transient' },
    expected: { failureCategory: 'transient', safeAction: 'retry', outcome: 'recovered_by_fallback', recoversRevenue: true },
    steps: (id) => [...mandateFailureWithRedelivery(id), { kind: 'drive' }, { kind: 'replay' }, { kind: 'drive' }, succeededEvent(id, 120_000, 'link-paid'), { kind: 'drive' }],
  },
  fallback_link_lapsed_exhausted: {
    simulator: { retry: 'failure', fallback: 'success', diagnosis: 'transient' },
    expected: { failureCategory: 'transient', safeAction: 'retry', outcome: 'exhausted', recoversRevenue: false },
    steps: (id) => [...mandateFailureWithRedelivery(id), { kind: 'drive' }, { kind: 'drive' }, { kind: 'advance', milliseconds: BEYOND_LINK_EXPIRY_MILLISECONDS }, { kind: 'expire' }, { kind: 'drive' }],
  },
  fallback_link_unavailable_exhausted: {
    simulator: { retry: 'failure', fallback: 'failure', diagnosis: 'transient' },
    expected: { failureCategory: 'transient', safeAction: 'retry', outcome: 'exhausted', recoversRevenue: false },
    steps: (id) => [...mandateFailureWithRedelivery(id), { kind: 'drive' }, { kind: 'drive' }, { kind: 'replay' }, { kind: 'drive' }],
  },
  late_success_after_exhaustion_recovered: {
    simulator: { retry: 'failure', fallback: 'failure', diagnosis: 'transient' },
    // The customer paid after the loop had run out of rungs. The money is real recovered revenue,
    // but no surviving action can be credited with collecting it.
    expected: { failureCategory: 'transient', safeAction: 'retry', outcome: 'recovered_unattributed', recoversRevenue: true },
    steps: (id) => [...mandateFailureWithRedelivery(id), { kind: 'drive' }, { kind: 'drive' }, succeededEvent(id, 180_000, 'settled-late'), { kind: 'drive' }],
  },
  hard_decline_escalated: {
    simulator: { retry: 'failure', fallback: 'failure', diagnosis: 'hard_decline' },
    expected: { failureCategory: 'hard_decline', safeAction: 'none', outcome: 'escalated', recoversRevenue: false },
    steps: (id) => [failedEvent(id, { method: 'recurring_mandate', failureCode: FAILURE_CODES.hardDecline }), { kind: 'drive' }, { kind: 'replay' }],
  },
  low_confidence_escalated: {
    simulator: { retry: 'success', fallback: 'success', diagnosis: 'low_confidence' },
    expected: { failureCategory: 'transient', safeAction: 'none', outcome: 'escalated', recoversRevenue: false },
    steps: (id) => [failedEvent(id, { method: 'recurring_mandate', failureCode: FAILURE_CODES.ambiguous }), { kind: 'drive' }, { kind: 'replay' }],
  },
  unusable_diagnosis_escalated: {
    simulator: { retry: 'success', fallback: 'success', diagnosis: 'malformed' },
    expected: { failureCategory: 'unknown', safeAction: 'none', outcome: 'escalated', recoversRevenue: false },
    steps: (id) => [failedEvent(id, { method: 'recurring_mandate', failureCode: FAILURE_CODES.unparseable }), { kind: 'drive' }, { kind: 'replay' }],
  },
  ineligible_method_fallback_recovered: {
    simulator: { retry: 'unsupported', fallback: 'success', diagnosis: 'transient' },
    // No authorized mandate, so the provider refuses the retry and the loop steps down a rung.
    expected: { failureCategory: 'transient', safeAction: 'fallback_link', outcome: 'recovered_by_fallback', recoversRevenue: true },
    steps: (id) => [failedEvent(id, { method: 'card', failureCode: FAILURE_CODES.temporary }), { kind: 'drive' }, { kind: 'replay' }, succeededEvent(id, 120_000, 'link-paid'), { kind: 'drive' }],
  },
  pre_existing_success_stopped: {
    simulator: { retry: 'success', fallback: 'success', diagnosis: 'transient' },
    // The renewal was paid outside the loop before anything was authorized.
    expected: { failureCategory: 'transient', safeAction: 'none', outcome: 'stopped', recoversRevenue: false },
    steps: (id) => [...mandateFailureWithRedelivery(id), succeededEvent(id, 30_000, 'settled-elsewhere'), { kind: 'drive' }],
  },
  cancelled_subscription_escalated: {
    simulator: { retry: 'success', fallback: 'success', diagnosis: 'transient' },
    expected: { failureCategory: 'cancelled', safeAction: 'none', outcome: 'escalated', recoversRevenue: false },
    steps: (id) => [
      failedEvent(id, { method: 'recurring_mandate', failureCode: FAILURE_CODES.insufficientFunds }),
      { kind: 'event', delivery: 'contradictory', id: `${id}:cancelled`, type: 'subscription_cancelled', occurredOffsetMilliseconds: 20_000, payload: {} },
      { kind: 'drive' },
    ],
  },
  mislabelled_hard_decline_exhausted: {
    simulator: { retry: 'failure', fallback: 'failure', diagnosis: 'hard_decline' },
    // The provider reported a temporary decline, but the issuer will refuse every attempt. Ground
    // truth says no action was safe; the loop cannot know that, so it spends both rungs and the
    // batch reports the deviation rather than hiding it.
    expected: { failureCategory: 'hard_decline', safeAction: 'none', outcome: 'exhausted', recoversRevenue: false },
    steps: (id) => [...mandateFailureWithRedelivery(id), { kind: 'drive' }, { kind: 'drive' }, { kind: 'replay' }, { kind: 'drive' }],
  },
} as const satisfies Readonly<Record<string, ArchetypeDefinition>>;

export type EvaluationArchetype = keyof typeof ARCHETYPE_DEFINITIONS;

export const EVALUATION_ARCHETYPES = Object.keys(ARCHETYPE_DEFINITIONS) as readonly EvaluationArchetype[];

export interface EvaluationCase {
  readonly id: string;
  readonly seed: number;
  readonly datasetVersion: string;
  readonly archetype: EvaluationArchetype;
  readonly context: RenewalContext;
  readonly simulator: SimulatorScenario;
  readonly steps: readonly EvaluationStep[];
  readonly expected: EvaluationExpectation;
}

export interface EvaluationCaseResult {
  readonly caseId: string;
  readonly archetype: EvaluationArchetype;
  readonly amountAtRisk: number;
  readonly expected: EvaluationExpectation;
  readonly outcome: EvaluationOutcome;
  readonly matchedExpectation: boolean;
  readonly recoveredAmount: number;
  readonly recoveryPath: RecoveryPath;
  /** The first action policy authorized, scored against the action ground truth calls safe. */
  readonly firstAuthorizedAction: RecoveryPath;
  readonly safeActionMatched: boolean;
  readonly diagnosedCategory?: FailureCategory;
  readonly diagnosedConfidence?: number;
  readonly diagnosisCorrect: boolean;
  readonly retryActions: number;
  readonly fallbackActions: number;
  /** Money operations the provider performed for this case. */
  readonly providerOperations: number;
  /** Money actions deterministic policy refused on this case. */
  readonly unsafeActionsPrevented: number;
  /** Re-drives through the workflow that performed no second money operation. */
  readonly duplicateActionsPrevented: number;
  readonly duplicateEventsIgnored: number;
  /** Late or contradictory deliveries the case recorded without letting them change its outcome. */
  readonly lateEventsIgnored: number;
  readonly auditEvents: number;
  readonly recoveryCase: RecoveryCase;
}

export interface EvaluationMetrics {
  /** Every number in this report comes from synthetic data and is not production performance. */
  readonly synthetic: true;
  readonly seed: number;
  readonly datasetVersion: string;
  readonly policyVersion: string;
  readonly diagnosisModelVersion: string;
  readonly startedAt: string;
  readonly totalCases: number;
  /** Total value of the failed renewals the batch evaluated, recovered or not. */
  readonly failedRenewalValue: number;
  readonly recoveredAmount: number;
  /** Renewal value the loop did not collect: the revenue still at risk when the batch ended. */
  readonly unrecoveredAmount: number;
  readonly recoveredCases: number;
  readonly recoveryRate: number;
  readonly retryRecoveredCases: number;
  readonly retryRecoveryRate: number;
  readonly fallbackRecoveredCases: number;
  readonly fallbackRecoveryRate: number;
  /** Recovered cases no surviving action can be credited with, rather than crediting one falsely. */
  readonly unattributedRecoveredCases: number;
  readonly escalatedCases: number;
  readonly escalationRate: number;
  readonly exhaustedCases: number;
  readonly exhaustionRate: number;
  readonly stoppedCases: number;
  readonly openCases: number;
  readonly diagnosedCases: number;
  readonly diagnosisAccuracy: number;
  readonly unsafeActionsPrevented: number;
  readonly duplicateActionsPrevented: number;
  readonly duplicateEventsIgnored: number;
  readonly lateEventsIgnored: number;
  /** Cases where the loop spent a rung ground truth calls unsafe, having been misled by the provider. */
  readonly safeActionMismatches: number;
  /** Cases whose observed outcome differed from ground truth. A trustworthy batch reports zero. */
  readonly expectationMismatches: number;
}

export interface EvaluationReport {
  readonly metrics: EvaluationMetrics;
  readonly results: readonly EvaluationCaseResult[];
}

export interface EvaluationOptions {
  /** Base timestamp for every case's clock, so expiry and ordering are reproducible. */
  readonly startedAt?: string;
  /**
   * The engine under evaluation. Defaults to the seeded signal engine so the batch needs no
   * credentials; pass the shipped engine to measure its diagnosis accuracy on the same dataset.
   */
  readonly diagnosisEngine?: DiagnosisEngine;
}

interface SignalPrediction {
  readonly failureCategory: FailureCategory;
  readonly confidence: number;
  readonly recommendedAction: Diagnosis['recommendedAction'];
  readonly explanation: string;
}

/** What the engine predicts from a provider failure code, or `undefined` when it cannot parse one. */
const PREDICTIONS: Readonly<Record<string, SignalPrediction | undefined>> = {
  [FAILURE_CODES.temporary]: { failureCategory: 'transient', confidence: 0.95, recommendedAction: 'retry', explanation: 'The provider reported a temporary decline on an authorized mandate.' },
  [FAILURE_CODES.insufficientFunds]: { failureCategory: 'transient', confidence: 0.88, recommendedAction: 'retry', explanation: 'The provider reported insufficient funds, which often clears on a later attempt.' },
  [FAILURE_CODES.hardDecline]: { failureCategory: 'hard_decline', confidence: 0.93, recommendedAction: 'escalate', explanation: 'The issuer declined the mandate outright, so no automated attempt is safe.' },
  [FAILURE_CODES.ambiguous]: { failureCategory: 'transient', confidence: 0.4, recommendedAction: 'retry', explanation: 'The issuer signal is ambiguous, so this diagnosis is not confident.' },
  [FAILURE_CODES.unparseable]: undefined,
};

/**
 * Predicts a diagnosis from the case's own signals, standing in for the model without a network
 * call. It reads only the failure code the provider reported, so the dataset can carry a
 * mislabelled failure the predictor gets wrong and the accuracy metric measures something real.
 */
export class SignalDiagnosisEngine implements DiagnosisEngine {
  async diagnose(recoveryCase: RecoveryCase): Promise<Diagnosis> {
    const attempt = [...recoveryCase.attempts].reverse().find((candidate) => candidate.status === 'failed');
    if (attempt === undefined) throw new DiagnosisUnavailableError('no failed payment attempt is on record');
    const prediction = attempt.failureCode === undefined ? undefined : PREDICTIONS[attempt.failureCode];
    // An unparseable provider signal is not something a further attempt fixes: fail safe.
    if (prediction === undefined) throw new DiagnosisUnavailableError(`failure code ${JSON.stringify(attempt.failureCode)} could not be interpreted`);
    return {
      failureCategory: prediction.failureCategory,
      confidence: prediction.confidence,
      evidence: [attempt.id],
      recommendedAction: prediction.recommendedAction,
      explanation: prediction.explanation,
      modelVersion: DIAGNOSIS_MODEL_VERSION,
    };
  }
}

/** Keeps the engine's first prediction, which the workflow overwrites once a retry steps down. */
class RecordingDiagnosisEngine implements DiagnosisEngine {
  readonly predictions: Diagnosis[] = [];

  constructor(private readonly inner: DiagnosisEngine) {}

  async diagnose(recoveryCase: RecoveryCase): Promise<Diagnosis> {
    const diagnosis = await this.inner.diagnose(recoveryCase);
    this.predictions.push(diagnosis);
    return diagnosis;
  }
}

function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

/**
 * Builds the seeded batch. The same seed produces the same cases, and the archetypes are cycled so
 * every scenario appears whenever `count` is at least the number of archetypes.
 */
export function generateEvaluationCases(count = 60, seed = 42): EvaluationCase[] {
  if (!Number.isInteger(count) || count < EVALUATION_ARCHETYPES.length) throw new Error(`count must be an integer of at least ${EVALUATION_ARCHETYPES.length}: ${count}`);
  const random = seededRandom(seed);
  return Array.from({ length: count }, (_, index) => {
    const archetype = EVALUATION_ARCHETYPES[index % EVALUATION_ARCHETYPES.length];
    if (archetype === undefined) throw new Error('The evaluation dataset defines no archetypes');
    const definition: ArchetypeDefinition = ARCHETYPE_DEFINITIONS[archetype];
    const id = `eval-${String(index + 1).padStart(4, '0')}`;
    // Minor currency units, rounded to whole rupees so dashboard totals read like real renewals.
    const amount = (50_000 + Math.floor(random() * 4_500)) * 100;
    return {
      id,
      seed,
      datasetVersion: DATASET_VERSION,
      archetype,
      context: {
        customerId: `customer-${index + 1}`,
        subscriptionId: `subscription-${index + 1}`,
        orderId: `order-${index + 1}`,
        amount,
        currency: 'INR',
        dueAt: '2026-01-01T00:00:00.000Z',
      },
      simulator: definition.simulator,
      steps: definition.steps(id),
      expected: definition.expected,
    };
  });
}

/** Which surviving action collected the renewal, or `none` when none can be credited. */
function recoveryPathOf(recoveryCase: RecoveryCase): RecoveryPath {
  if (recoveryCase.status !== 'recovered') return 'none';
  const standing = recoveryCase.actions.filter((action) => action.status !== 'failed' && action.status !== 'blocked');
  if (standing.some((action) => action.kind === 'fallback_link')) return 'fallback_link';
  return standing.some((action) => action.kind === 'retry') ? 'retry' : 'none';
}

function outcomeOf(recoveryCase: RecoveryCase, path: RecoveryPath): EvaluationOutcome {
  switch (recoveryCase.status) {
    case 'recovered':
      return path === 'fallback_link' ? 'recovered_by_fallback' : path === 'retry' ? 'recovered_by_retry' : 'recovered_unattributed';
    case 'escalated': return 'escalated';
    case 'exhausted': return 'exhausted';
    case 'stopped': return 'stopped';
    default: return 'open';
  }
}

/** The first rung policy authorized on this case, which ground truth's safe action is scored against. */
function firstAuthorizedActionOf(recoveryCase: RecoveryCase): RecoveryPath {
  const first = recoveryCase.actions.find((action) => action.kind === 'retry' || action.kind === 'fallback_link');
  return first?.kind === 'retry' || first?.kind === 'fallback_link' ? first.kind : 'none';
}

async function runCase(evaluationCase: EvaluationCase, startedAt: string, engine: DiagnosisEngine): Promise<EvaluationCaseResult> {
  const clock = new FixedClock(startedAt);
  const startedAtMilliseconds = clock.now().getTime();
  const store = new InMemoryRecoveryStore();
  const provider = new DeterministicSimulator(new Map([[evaluationCase.id, evaluationCase.simulator]]), clock);
  const recording = new RecordingDiagnosisEngine(engine);
  // A no-op sleep keeps a retried diagnosis instant; the batch measures the loop, not backoff.
  const workflow = new RecoveryWorkflow(store, provider, recording, new DeterministicPolicy(), clock, { sleep: async () => {} });

  const current = async (): Promise<RecoveryCase> => {
    const found = await store.get(evaluationCase.id);
    if (!found) throw new Error(`Recovery Case disappeared during evaluation: ${evaluationCase.id}`);
    return found;
  };

  await workflow.openCase(evaluationCase.id, evaluationCase.context);
  let duplicateEventsIgnored = 0;
  let duplicateActionsPrevented = 0;

  for (const step of evaluationCase.steps) {
    clock.advance(STEP_TICK_MILLISECONDS);
    if (step.kind === 'advance') {
      clock.advance(step.milliseconds);
    } else if (step.kind === 'event') {
      const before = (await current()).events.length;
      const event = provider.normalizeEvent({
        id: step.id,
        type: step.type,
        caseId: evaluationCase.id,
        ...(step.providerPaymentId === undefined ? {} : { providerPaymentId: step.providerPaymentId }),
        occurredAt: new Date(startedAtMilliseconds + step.occurredOffsetMilliseconds).toISOString(),
        ...(step.payload === undefined ? {} : { payload: step.payload }),
      }, clock.now().toISOString());
      const ingested = await workflow.ingestEvent(event);
      // An identity the case already holds must change nothing, however it was delivered.
      if (ingested.events.length === before) duplicateEventsIgnored += 1;
    } else if (step.kind === 'drive') {
      await workflow.drive(evaluationCase.id);
    } else if (step.kind === 'expire') {
      await workflow.expireLapsedFallbackLink(evaluationCase.id);
    } else {
      // A redelivered or retried request re-enters through the same calls the webhook makes.
      // Whatever the case has already spent, this must perform no second money operation.
      const operationsBefore = provider.calls.length;
      const spentBefore = (await current()).actions.filter((action) => action.kind === 'retry' || action.kind === 'fallback_link').length;
      await workflow.executePending(evaluationCase.id);
      await workflow.drive(evaluationCase.id);
      // Only a case that already holds a money action could have repeated one. Crediting a replay
      // of a case that never spent a rung would inflate the headline with guaranteed no-ops.
      if (spentBefore > 0 && provider.calls.length === operationsBefore) duplicateActionsPrevented += 1;
    }
  }

  const settled = await current();
  const path = recoveryPathOf(settled);
  const outcome = outcomeOf(settled, path);
  const prediction = recording.predictions[0];
  const firstAuthorizedAction = firstAuthorizedActionOf(settled);
  return {
    caseId: settled.id,
    archetype: evaluationCase.archetype,
    amountAtRisk: settled.context.amount,
    expected: evaluationCase.expected,
    outcome,
    matchedExpectation: outcome === evaluationCase.expected.outcome && (settled.recoveredAmount > 0) === evaluationCase.expected.recoversRevenue,
    recoveredAmount: settled.recoveredAmount,
    recoveryPath: path,
    firstAuthorizedAction,
    safeActionMatched: firstAuthorizedAction === evaluationCase.expected.safeAction,
    ...(prediction === undefined ? {} : { diagnosedCategory: prediction.failureCategory, diagnosedConfidence: prediction.confidence }),
    diagnosisCorrect: prediction?.failureCategory === evaluationCase.expected.failureCategory,
    retryActions: settled.actions.filter((action) => action.kind === 'retry').length,
    fallbackActions: settled.actions.filter((action) => action.kind === 'fallback_link').length,
    providerOperations: provider.calls.length,
    unsafeActionsPrevented: settled.audit.filter((event) => event.type === 'policy_blocked').length,
    duplicateActionsPrevented,
    duplicateEventsIgnored,
    lateEventsIgnored: settled.audit.filter((event) => event.type === 'late_event_ignored').length,
    auditEvents: settled.audit.length,
    recoveryCase: settled,
  };
}

function rate(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

/**
 * Runs the seeded batch and reports metrics that reconcile to the individual Recovery Cases. Each
 * case gets its own store, simulator, and clock, so nothing leaks between cases and the batch can
 * be replayed to the same totals.
 */
export async function runEvaluation(
  cases: readonly EvaluationCase[] = generateEvaluationCases(),
  options: EvaluationOptions = {},
): Promise<EvaluationReport> {
  const first = cases[0];
  // Publishing zeros for an empty batch would be the least honest number a dashboard could show.
  if (first === undefined) throw new Error('An evaluation run needs at least one case');
  const startedAt = options.startedAt ?? DEFAULT_STARTED_AT;
  if (Number.isNaN(Date.parse(startedAt))) throw new Error(`startedAt must be a valid timestamp: ${startedAt}`);
  const engine = options.diagnosisEngine ?? new SignalDiagnosisEngine();
  const results: EvaluationCaseResult[] = [];
  for (const evaluationCase of cases) results.push(await runCase(evaluationCase, startedAt, engine));

  const totalCases = results.length;
  const count = (predicate: (result: EvaluationCaseResult) => boolean): number => results.filter(predicate).length;
  const sum = (project: (result: EvaluationCaseResult) => number): number => results.reduce((total, result) => total + project(result), 0);
  const failedRenewalValue = sum((result) => result.amountAtRisk);
  const recoveredAmount = sum((result) => result.recoveredAmount);
  const recoveredCases = count((result) => result.recoveredAmount > 0);
  const retryRecoveredCases = count((result) => result.recoveryPath === 'retry');
  const fallbackRecoveredCases = count((result) => result.recoveryPath === 'fallback_link');
  const unattributedRecoveredCases = count((result) => result.outcome === 'recovered_unattributed');
  // Recovered money and recovered cases are counted independently, so a batch that cannot
  // reconcile the two must fail rather than publish a total no case outcome accounts for.
  if (recoveredCases !== retryRecoveredCases + fallbackRecoveredCases + unattributedRecoveredCases) {
    throw new Error(`Recovered revenue does not reconcile to case outcomes: ${recoveredCases} cases hold recovered revenue but ${retryRecoveredCases + fallbackRecoveredCases + unattributedRecoveredCases} are attributed`);
  }
  const escalatedCases = count((result) => result.outcome === 'escalated');
  const exhaustedCases = count((result) => result.outcome === 'exhausted');
  const diagnosedCases = count((result) => result.diagnosedCategory !== undefined);

  return {
    metrics: {
      synthetic: true,
      seed: first.seed,
      datasetVersion: first.datasetVersion,
      policyVersion: POLICY_VERSION,
      diagnosisModelVersion: DIAGNOSIS_MODEL_VERSION,
      startedAt,
      totalCases,
      failedRenewalValue,
      recoveredAmount,
      unrecoveredAmount: failedRenewalValue - recoveredAmount,
      recoveredCases,
      recoveryRate: rate(recoveredCases, totalCases),
      retryRecoveredCases,
      retryRecoveryRate: rate(retryRecoveredCases, totalCases),
      fallbackRecoveredCases,
      fallbackRecoveryRate: rate(fallbackRecoveredCases, totalCases),
      unattributedRecoveredCases,
      escalatedCases,
      escalationRate: rate(escalatedCases, totalCases),
      exhaustedCases,
      exhaustionRate: rate(exhaustedCases, totalCases),
      stoppedCases: count((result) => result.outcome === 'stopped'),
      openCases: count((result) => result.outcome === 'open'),
      diagnosedCases,
      diagnosisAccuracy: rate(count((result) => result.diagnosisCorrect), diagnosedCases),
      unsafeActionsPrevented: sum((result) => result.unsafeActionsPrevented),
      duplicateActionsPrevented: sum((result) => result.duplicateActionsPrevented),
      duplicateEventsIgnored: sum((result) => result.duplicateEventsIgnored),
      lateEventsIgnored: sum((result) => result.lateEventsIgnored),
      safeActionMismatches: count((result) => !result.safeActionMatched),
      expectationMismatches: count((result) => !result.matchedExpectation),
    },
    results,
  };
}
