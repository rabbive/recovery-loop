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
  /**
   * The provider object a recovery action created, when the payment names one. A customer paying
   * a fallback link produces a payment whose own id the link never carried, so without the link
   * id the success cannot be tied back to the action that offered it.
   */
  readonly providerActionReference?: string;
  /** The action identity the adapter wrote into the provider's notes, echoed back on the event. */
  readonly actionIdempotencyKey?: string;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Why a renewal counts as recovered revenue. Recovered Revenue is counted only through explicit
 * correlation, so the figure carries the action that earned it and the provider payment that
 * settled it: an operator reconciling the dashboard can name both without reading the timeline.
 */
export interface RecoveryAttribution {
  readonly actionId: string;
  readonly actionKind: 'retry' | 'fallback_link';
  readonly idempotencyKey: string;
  readonly providerReference: string;
  readonly providerPaymentId: string;
  readonly eventId: string;
  readonly occurredAt: string;
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

/**
 * Every kind of entry the timeline can hold. It is a union rather than a string because the
 * counters and projections that read the timeline match these spellings: with a free-form string,
 * renaming an emitter would silently zero a published figure and still typecheck.
 *
 * These strings are persisted — in `audit_events.type` and inside the `recovery_cases.state`
 * document, which hydrates back through an unvalidated cast. Renaming one is therefore a data
 * migration, not a type edit: rows written under the old spelling keep it, hydrate as an entry
 * this union says cannot exist, and read as zero wherever a counter matches on the new name.
 */
export type AuditEventType =
  | 'case_opened'
  | `case_${Exclude<CaseStatus, 'at_risk' | 'diagnosed' | 'retry_scheduled' | 'fallback_link_available'>}`
  | 'diagnosis_created'
  | 'diagnosis_unavailable'
  | 'policy_allowed'
  | 'policy_blocked'
  | 'provider_event_received'
  | 'provider_action_result'
  | 'retry_failed'
  | 'retry_ineligible'
  | 'fallback_link_expired'
  | 'late_event_ignored'
  | 'pre_existing_success'
  | 'uncorrelated_success'
  | 'manual_stop'
  | 'manual_escalation'
  | 'manual_action_ignored';

export interface AuditEvent {
  readonly id: string;
  readonly caseId: string;
  readonly type: AuditEventType;
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
  /** Present exactly when `recoveredAmount` is greater than zero. See `RecoveryAttribution`. */
  readonly recoveryAttribution?: RecoveryAttribution;
}

export const terminalStatuses = new Set<CaseStatus>(['recovered', 'escalated', 'exhausted', 'stopped']);

const allowedTransitions: Readonly<Record<CaseStatus, readonly CaseStatus[]>> = {
  // A recovery action can settle late, so any status that could have authorized one still
  // reaches recovered. `at_risk` cannot: nothing was authorized there, and a renewal paid
  // without a recovery action is stood down as stopped rather than counted as recovered.
  at_risk: ['at_risk', 'diagnosed', 'escalated', 'stopped'],
  diagnosed: ['diagnosed', 'retry_scheduled', 'fallback_link_available', 'recovered', 'escalated', 'stopped'],
  retry_scheduled: ['retry_scheduled', 'diagnosed', 'fallback_link_available', 'recovered', 'escalated', 'exhausted', 'stopped'],
  fallback_link_available: ['fallback_link_available', 'recovered', 'exhausted', 'escalated', 'stopped'],
  recovered: ['recovered'],
  // A case handed to a human, or one that ran out of bounded actions, can still be paid.
  // Reconciling that success keeps recovered revenue honest; no new action becomes possible.
  escalated: ['escalated', 'recovered'],
  exhausted: ['exhausted', 'recovered'],
  stopped: ['stopped'],
};

/** Every status a Recovery Case can hold, derived from the transition table so the two cannot drift. */
export const caseStatuses = Object.keys(allowedTransitions) as readonly CaseStatus[];

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

/**
 * Describes why a renewal context cannot be trusted, or undefined when it is intact. A case
 * rehydrated from storage never passed through `createRecoveryCase`, so policy re-checks this
 * before authorizing anything that moves money.
 */
export function renewalContextViolation(context: RenewalContext): string | undefined {
  const intact = 'Renewal context is not intact';
  if (!context.customerId || !context.subscriptionId || !context.orderId) return `${intact}: customer, subscription, and order identifiers are required`;
  if (!Number.isSafeInteger(context.amount) || context.amount <= 0) return `${intact}: amount must be a positive safe integer in minor currency units`;
  if (!/^[A-Z]{3}$/.test(context.currency)) return `${intact}: currency must be an uppercase ISO 4217 code`;
  if (Number.isNaN(Date.parse(context.dueAt))) return `${intact}: dueAt must be a valid timestamp`;
  return undefined;
}

function validateRenewalContext(context: RenewalContext): RenewalContext {
  const violation = renewalContextViolation(context);
  if (violation) throw new Error(violation);
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

/**
 * The fallback link the case is resting on, if any, and whether the customer can still pay it.
 * One rule, shared: policy blocks further action while a link is `live`, the workflow retires one
 * that has lapsed, and the customer message preview offers only a link this calls live. Letting
 * each of them decide separately is how a customer gets asked to pay a link that is not payable.
 */
export function fallbackLinkState(recoveryCase: RecoveryCase, now: string): { readonly action: RecoveryAction; readonly live: boolean } | undefined {
  const action = recoveryCase.actions.find((candidate) => candidate.kind === 'fallback_link' && candidate.status !== 'failed' && candidate.expiresAt !== undefined);
  return action === undefined ? undefined : { action, live: Date.parse(action.expiresAt ?? '') > Date.parse(now) };
}

/**
 * The Recovery Action a success belongs to, or `undefined` when nothing on the case earned it.
 *
 * "The case has an action" is not correlation. A blocked action moved no money, an action created
 * after the payment cannot have caused it, and a payment naming a different provider object
 * belongs to someone else. Every condition here is evidence the provider or policy recorded, so a
 * recovered figure can be traced rather than inferred.
 */
export function matchRecoveryAction(recoveryCase: RecoveryCase, event: ProviderEvent): RecoveryAction | undefined {
  // Reconciliation needs a payment to point at; a success with no payment id names nothing.
  if (!event.providerPaymentId) return undefined;
  return recoveryCase.actions.find((action) => {
    if (action.kind !== 'retry' && action.kind !== 'fallback_link') return false;
    // References are never synthesized: an action the provider never acknowledged has none.
    if (!action.providerReference) return false;
    const referenceMatches = event.providerPaymentId === action.providerReference
      || event.providerActionReference === action.providerReference
      || event.actionIdempotencyKey === action.idempotencyKey;
    if (!referenceMatches) return false;
    // Policy is the only authorizer, so an action it never allowed cannot earn revenue.
    const allowed = recoveryCase.decisions.some((decision) =>
      decision.allowed && decision.action === action.kind && Date.parse(decision.decidedAt) <= Date.parse(action.createdAt));
    return allowed && Date.parse(event.occurredAt) >= Date.parse(action.createdAt);
  });
}

/** Builds the attribution for a matched action, or `undefined` when the match is not reconcilable. */
export function recoveryAttribution(action: RecoveryAction, event: ProviderEvent): RecoveryAttribution | undefined {
  if (action.kind !== 'retry' && action.kind !== 'fallback_link') return undefined;
  if (!action.providerReference || !event.providerPaymentId) return undefined;
  return {
    actionId: action.id,
    actionKind: action.kind,
    idempotencyKey: action.idempotencyKey,
    providerReference: action.providerReference,
    providerPaymentId: event.providerPaymentId,
    eventId: event.id,
    occurredAt: event.occurredAt,
  };
}

export function markRecovered(recoveryCase: RecoveryCase, attribution: RecoveryAttribution, now: string): RecoveryCase {
  if (!canTransition(recoveryCase.status, 'recovered')) throw new InvalidCaseTransitionError(recoveryCase.status, 'recovered');
  return { ...recoveryCase, status: 'recovered', outcome: 'recovered', recoveredAmount: recoveryCase.context.amount, recoveryAttribution: attribution, updatedAt: now };
}
