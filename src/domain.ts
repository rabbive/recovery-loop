export type CaseStatus =
  | 'at_risk'
  | 'diagnosed'
  | 'retry_scheduled'
  | 'fallback_link_available'
  | 'recovered'
  | 'escalated'
  | 'exhausted'
  | 'stopped';

export type FailureCategory =
  | 'transient'
  | 'hard_decline'
  | 'expired'
  | 'cancelled'
  | 'dispute'
  | 'unsupported'
  | 'unknown';

export type RecommendedAction = 'retry' | 'fallback_link' | 'stop' | 'escalate';
export type ActionKind = 'retry' | 'fallback_link' | 'stop' | 'escalate';
export type ActionStatus = 'pending' | 'submitted' | 'succeeded' | 'failed' | 'blocked';

export interface RenewalContext {
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly orderId: string;
  readonly amount: number;
  readonly currency: string;
  readonly dueAt: string;
}

export interface PaymentAttempt {
  readonly id: string;
  readonly providerPaymentId: string;
  readonly method: 'recurring_mandate' | 'card' | 'upi' | 'unknown';
  readonly status: 'failed' | 'succeeded' | 'pending';
  readonly failureCode?: string;
  readonly occurredAt: string;
}

export interface ProviderEvent {
  readonly id: string;
  readonly type: 'payment_failed' | 'payment_succeeded' | 'payment_pending' | 'subscription_cancelled' | 'dispute_opened' | 'unknown';
  readonly caseId: string;
  readonly providerPaymentId?: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface Diagnosis {
  readonly failureCategory: FailureCategory;
  readonly confidence: number;
  readonly evidence: readonly string[];
  readonly recommendedAction: RecommendedAction;
  readonly explanation: string;
  readonly modelVersion: string;
}

export interface PolicyDecision {
  readonly action: ActionKind;
  readonly allowed: boolean;
  readonly reason: string;
  readonly policyVersion: string;
  readonly decidedAt: string;
}

export interface RecoveryAction {
  readonly id: string;
  readonly kind: ActionKind;
  readonly status: ActionStatus;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly providerReference?: string;
  readonly expiresAt?: string;
  readonly result?: string;
}

export interface AuditEvent {
  readonly id: string;
  readonly caseId: string;
  readonly type: string;
  readonly actor: 'system' | 'diagnosis_model' | 'policy' | 'provider' | 'operator';
  readonly at: string;
  readonly explanation: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface RecoveryCase {
  readonly id: string;
  readonly context: RenewalContext;
  readonly status: CaseStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: readonly PaymentAttempt[];
  readonly events: readonly ProviderEvent[];
  readonly diagnosis?: Diagnosis;
  readonly decisions: readonly PolicyDecision[];
  readonly actions: readonly RecoveryAction[];
  readonly audit: readonly AuditEvent[];
  readonly recoveredAmount: number;
  readonly outcome?: 'recovered' | 'escalated' | 'exhausted' | 'stopped';
}

export const terminalStatuses = new Set<CaseStatus>(['recovered', 'escalated', 'exhausted', 'stopped']);

const allowedTransitions: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  at_risk: ['at_risk', 'diagnosed', 'escalated', 'stopped'],
  diagnosed: ['diagnosed', 'retry_scheduled', 'fallback_link_available', 'escalated', 'stopped'],
  retry_scheduled: ['retry_scheduled', 'diagnosed', 'fallback_link_available', 'recovered', 'escalated', 'exhausted', 'stopped'],
  fallback_link_available: ['fallback_link_available', 'recovered', 'exhausted', 'escalated', 'stopped'],
  recovered: ['recovered'],
  // A case handed to a human, or one that ran out of bounded actions, can still be paid.
  // Reconciling that success keeps recovered revenue honest; no new action becomes possible.
  escalated: ['escalated', 'recovered'],
  exhausted: ['exhausted', 'recovered'],
  stopped: ['stopped'],
};

export class InvalidCaseTransitionError extends Error {
  constructor(readonly from: CaseStatus, readonly to: CaseStatus) {
    super(`Invalid Recovery Case transition: ${from} -> ${to}`);
    this.name = 'InvalidCaseTransitionError';
  }
}

export function isTerminal(status: CaseStatus): boolean {
  return terminalStatuses.has(status);
}

export function canTransition(from: CaseStatus, to: CaseStatus): boolean {
  return allowedTransitions[from].includes(to);
}

function validateRenewalContext(context: RenewalContext): RenewalContext {
  if (!context.customerId || !context.subscriptionId || !context.orderId) throw new Error('Renewal context requires customer, subscription, and order identifiers');
  if (!Number.isSafeInteger(context.amount) || context.amount <= 0) throw new Error('Renewal amount must be a positive safe integer in minor currency units');
  if (!/^[A-Z]{3}$/.test(context.currency)) throw new Error('Renewal currency must be an uppercase ISO 4217 code');
  if (Number.isNaN(Date.parse(context.dueAt))) throw new Error('Renewal dueAt must be a valid timestamp');
  return Object.freeze({ ...context });
}

export function createRecoveryCase(id: string, context: RenewalContext, now: string): RecoveryCase {
  if (!id) throw new Error('Recovery Case id is required');
  const immutableContext = validateRenewalContext(context);
  return {
    id,
    context: immutableContext,
    status: 'at_risk',
    createdAt: now,
    updatedAt: now,
    attempts: [],
    events: [],
    decisions: [],
    actions: [],
    audit: [],
    recoveredAmount: 0,
  };
}

export function appendAudit(
  recoveryCase: RecoveryCase,
  event: Omit<AuditEvent, 'id' | 'caseId'>,
): RecoveryCase {
  const auditEvent: AuditEvent = {
    ...event,
    id: `${recoveryCase.id}:audit:${recoveryCase.audit.length + 1}`,
    caseId: recoveryCase.id,
    data: Object.freeze({ ...event.data }),
  };
  return { ...recoveryCase, audit: [...recoveryCase.audit, auditEvent], updatedAt: event.at };
}

export function withStatus(
  recoveryCase: RecoveryCase,
  status: CaseStatus,
  now: string,
  outcome?: RecoveryCase['outcome'],
): RecoveryCase {
  if (!canTransition(recoveryCase.status, status)) throw new InvalidCaseTransitionError(recoveryCase.status, status);
  return {
    ...recoveryCase,
    status,
    ...(outcome === undefined ? {} : { outcome }),
    updatedAt: now,
  };
}

export function addProviderEvent(recoveryCase: RecoveryCase, event: ProviderEvent): RecoveryCase {
  const existing = recoveryCase.events.find((candidate) => candidate.id === event.id);
  if (existing) return recoveryCase;
  return { ...recoveryCase, events: [...recoveryCase.events, Object.freeze({ ...event, payload: Object.freeze({ ...event.payload }) })], updatedAt: event.receivedAt };
}

export function addAttempt(recoveryCase: RecoveryCase, attempt: PaymentAttempt): RecoveryCase {
  if (recoveryCase.attempts.some((existing) => existing.id === attempt.id)) return recoveryCase;
  return { ...recoveryCase, attempts: [...recoveryCase.attempts, attempt], updatedAt: attempt.occurredAt };
}

export function addAction(recoveryCase: RecoveryCase, action: RecoveryAction, now: string): RecoveryCase {
  if (recoveryCase.actions.some((existing) => existing.idempotencyKey === action.idempotencyKey)) return recoveryCase;
  return { ...recoveryCase, actions: [...recoveryCase.actions, action], updatedAt: now };
}

export function withDiagnosis(recoveryCase: RecoveryCase, diagnosis: Diagnosis, now: string): RecoveryCase {
  if (!canTransition(recoveryCase.status, 'diagnosed')) throw new InvalidCaseTransitionError(recoveryCase.status, 'diagnosed');
  if (!Number.isFinite(diagnosis.confidence) || diagnosis.confidence < 0 || diagnosis.confidence > 1) throw new Error('Diagnosis confidence must be between 0 and 1');
  return { ...recoveryCase, diagnosis: Object.freeze({ ...diagnosis, evidence: Object.freeze([...diagnosis.evidence]) }), status: 'diagnosed', updatedAt: now };
}

export function addDecision(recoveryCase: RecoveryCase, decision: PolicyDecision): RecoveryCase {
  return { ...recoveryCase, decisions: [...recoveryCase.decisions, decision], updatedAt: decision.decidedAt };
}

export function updateAction(
  recoveryCase: RecoveryCase,
  idempotencyKey: string,
  update: Partial<RecoveryAction>,
  now: string,
): RecoveryCase {
  return {
    ...recoveryCase,
    actions: recoveryCase.actions.map((action) =>
      action.idempotencyKey === idempotencyKey ? { ...action, ...update } : action,
    ),
    updatedAt: now,
  };
}

export function markRecovered(recoveryCase: RecoveryCase, now: string): RecoveryCase {
  if (!canTransition(recoveryCase.status, 'recovered')) throw new InvalidCaseTransitionError(recoveryCase.status, 'recovered');
  return { ...recoveryCase, status: 'recovered', outcome: 'recovered', recoveredAmount: recoveryCase.context.amount, updatedAt: now };
}
