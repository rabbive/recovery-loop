import {
  addAction,
  addAttempt,
  addDecision,
  addProviderEvent,
  appendAudit,
  canTransition,
  createRecoveryCase,
  fallbackLinkState,
  isTerminal,
  markRecovered,
  renewalContextViolation,
  updateAction,
  withDiagnosis,
  withStatus,
  type ActionKind,
  type Diagnosis,
  type PaymentAttempt,
  type PolicyDecision,
  type ProviderEvent,
  type RecoveryAction,
  type RecoveryCase,
} from './domain.js';
import type { Clock, PaymentProvider } from './provider.js';
import { DiagnosisUnavailableError as DiagnosisFailure, type DiagnosisEngine as Engine } from './diagnosis.js';

export { AnthropicDiagnosisEngine, DiagnosisUnavailableError, FixtureDiagnosisEngine, type DiagnosisEngine } from './diagnosis.js';

/** The version stamped on every policy decision. Reported with evaluation results so a batch is reproducible. */
export const POLICY_VERSION = 'policy-v1';

export interface Policy {
  decide(recoveryCase: RecoveryCase, diagnosis: Diagnosis, now: string): PolicyDecision;
}

/**
 * The payment method the provider reported, defaulting to `card`. Retry eligibility turns on
 * this: only an authorized recurring mandate can be collected again without the customer.
 */
function eventPaymentMethod(event: ProviderEvent): PaymentAttempt['method'] {
  const method = event.payload.method;
  return method === 'recurring_mandate' || method === 'upi' || method === 'card' ? method : 'card';
}

export class DeterministicPolicy implements Policy {
  constructor(private readonly minimumConfidence = 0.75) {}

  decide(recoveryCase: RecoveryCase, diagnosis: Diagnosis, now: string): PolicyDecision {
    const reject = (action: ActionKind, reason: string): PolicyDecision => ({
      action,
      allowed: false,
      reason,
      policyVersion: POLICY_VERSION,
      decidedAt: now,
    });

    if (isTerminal(recoveryCase.status)) return reject(diagnosis.recommendedAction, 'Case is terminal');
    // Integrity of the money-bearing facts comes before any judgement about the failure itself.
    if (recoveryCase.recoveredAmount > 0) return reject('stop', 'The renewal is already recovered');
    const violation = renewalContextViolation(recoveryCase.context);
    if (violation) return reject('escalate', violation);
    if (!recoveryCase.attempts.some((attempt) => attempt.status === 'failed')) return reject('escalate', 'No failed payment attempt is recorded for this renewal');
    const fallbackLink = fallbackLinkState(recoveryCase, now);
    if (fallbackLink?.live) return reject('escalate', `A fallback link is still live until ${fallbackLink.action.expiresAt}`);
    if (diagnosis.confidence < this.minimumConfidence) return reject('escalate', 'Diagnosis confidence is below policy threshold');
    if (diagnosis.failureCategory === 'hard_decline' || diagnosis.failureCategory === 'cancelled' || diagnosis.failureCategory === 'dispute') {
      return reject('escalate', `Failure category ${diagnosis.failureCategory} is not safe to automate`);
    }
    if (diagnosis.failureCategory === 'unknown' || diagnosis.failureCategory === 'unsupported') return reject('escalate', 'Failure category is unsupported');
    if (diagnosis.recommendedAction === 'retry') {
      if (recoveryCase.actions.some((action) => action.kind === 'retry')) return reject('escalate', 'Retry limit has been reached');
      return { action: 'retry', allowed: true, reason: 'Diagnosis recommends a bounded retry and policy checks passed', policyVersion: POLICY_VERSION, decidedAt: now };
    }
    if (diagnosis.recommendedAction === 'fallback_link') {
      if (recoveryCase.actions.some((action) => action.kind === 'fallback_link')) return reject('escalate', 'Fallback-link limit has been reached');
      return { action: 'fallback_link', allowed: true, reason: 'Fallback link is the next bounded action', policyVersion: POLICY_VERSION, decidedAt: now };
    }
    if (diagnosis.recommendedAction === 'stop') return reject('stop', 'Diagnosis requested stop; human confirmation is required');
    return reject('escalate', 'Diagnosis requested escalation');
  }
}

export interface RecoveryStore {
  get(id: string): Promise<RecoveryCase | undefined>;
  save(recoveryCase: RecoveryCase): Promise<void>;
  all(): Promise<RecoveryCase[]>;
}

export class InMemoryRecoveryStore implements RecoveryStore {
  private readonly cases = new Map<string, RecoveryCase>();
  async get(id: string): Promise<RecoveryCase | undefined> { return this.cases.get(id); }
  async save(recoveryCase: RecoveryCase): Promise<void> { this.cases.set(recoveryCase.id, recoveryCase); }
  async all(): Promise<RecoveryCase[]> { return [...this.cases.values()]; }
}

export interface RecoveryWorkflowOptions {
  /** Bounded diagnosis attempts per run, including the first. */
  readonly maxDiagnosisAttempts?: number;
  /** Backoff seam; tests inject a no-op so retries stay instant and deterministic. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Base backoff applied between diagnosis attempts when the provider advertises no delay. */
  readonly retryBackoffMilliseconds?: number;
}

export class RecoveryWorkflow {
  private readonly maxDiagnosisAttempts: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly retryBackoffMilliseconds: number;

  constructor(
    private readonly store: RecoveryStore,
    private readonly provider: PaymentProvider,
    private readonly diagnosis: Engine,
    private readonly policy: Policy,
    private readonly clock: Clock,
    options: RecoveryWorkflowOptions = {},
  ) {
    this.maxDiagnosisAttempts = options.maxDiagnosisAttempts ?? 3;
    if (!Number.isInteger(this.maxDiagnosisAttempts) || this.maxDiagnosisAttempts < 1) throw new Error(`maxDiagnosisAttempts must be a positive integer: ${this.maxDiagnosisAttempts}`);
    this.retryBackoffMilliseconds = options.retryBackoffMilliseconds ?? 1000;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async openCase(id: string, context: Parameters<typeof createRecoveryCase>[1]): Promise<RecoveryCase> {
    const now = this.clock.now().toISOString();
    const recoveryCase = appendAudit(createRecoveryCase(id, context, now), {
      type: 'case_opened', actor: 'system', at: now, explanation: 'Recovery Case opened for a failed renewal', data: { orderId: context.orderId },
    });
    await this.store.save(recoveryCase);
    return recoveryCase;
  }

  async ingestEvent(event: ProviderEvent): Promise<RecoveryCase> {
    const current = await this.requireCase(event.caseId);
    let updated = addProviderEvent(current, event);
    if (updated === current) return current;
    updated = appendAudit(updated, { type: 'provider_event_received', actor: 'provider', at: event.receivedAt, explanation: `Received ${event.type}`, data: { eventId: event.id } });
    const ignore = (explanation: string): RecoveryCase =>
      appendAudit(updated, { type: 'late_event_ignored', actor: 'provider', at: event.receivedAt, explanation, data: { eventId: event.id, eventType: event.type, status: current.status } });

    // Money settles independently of the loop, so a success is judged before any terminal guard:
    // the case may have been escalated or exhausted while the payment was still in flight.
    if (event.type === 'payment_succeeded') {
      const caused = current.actions.some((action) => action.kind === 'retry' || action.kind === 'fallback_link');
      updated = current.status === 'recovered'
        ? ignore('The renewal was already recovered')
        : caused && canTransition(current.status, 'recovered')
          ? this.recover(updated, event.occurredAt)
          // The renewal is paid but no recovery action caused it, so it is not recovered revenue.
          // The loop must still stand down: retrying a paid renewal would collect it twice.
          : this.standDown(updated, event);
    } else if (isTerminal(current.status)) {
      // Anything else arriving after an outcome is history: record it, never re-open the case.
      updated = ignore('A terminal case cannot change state after this provider signal');
    } else if (event.type === 'payment_failed') {
      const outstandingRetry = current.actions.find((action) => action.kind === 'retry' && (action.status === 'submitted' || action.status === 'pending'));
      updated = current.attempts.length === 0
        ? addAttempt(updated, {
          id: `${current.id}:attempt:1`,
          providerPaymentId: event.providerPaymentId ?? `${current.id}:payment`,
          method: eventPaymentMethod(event),
          status: 'failed',
          ...(typeof event.payload.failureCode === 'string' ? { failureCode: event.payload.failureCode } : {}),
          occurredAt: event.occurredAt,
        })
        : outstandingRetry
          // The provider only accepted the retry earlier; this failure is its real outcome.
          ? this.recordRetryFailure(updated, outstandingRetry, event)
          : ignore('The renewal already has a recorded failed attempt and no outstanding action');
    } else if (event.type === 'subscription_cancelled' || event.type === 'dispute_opened') {
      updated = this.escalateCase(updated, `Provider reported ${event.type}`, event.receivedAt);
    }
    await this.store.save(updated);
    return updated;
  }

  /** Reaching an outcome is itself auditable, so every terminal transition goes through here. */
  private settle(recoveryCase: RecoveryCase, status: 'recovered' | 'escalated' | 'exhausted' | 'stopped', at: string, explanation: string, data: Record<string, unknown> = {}): RecoveryCase {
    return appendAudit(withStatus(recoveryCase, status, at, status), { type: `case_${status}`, actor: 'system', at, explanation, data });
  }

  private recover(recoveryCase: RecoveryCase, at: string): RecoveryCase {
    const recovered = markRecovered(recoveryCase, at);
    return appendAudit(recovered, { type: 'case_recovered', actor: 'system', at, explanation: 'A recovery action collected the renewal', data: { recoveredAmount: recovered.recoveredAmount } });
  }

  private escalateCase(recoveryCase: RecoveryCase, explanation: string, at: string): RecoveryCase {
    return this.settle(recoveryCase, 'escalated', at, explanation);
  }

  /** Retires the loop for a renewal that was paid without any recovery action causing it. */
  private standDown(recoveryCase: RecoveryCase, event: ProviderEvent): RecoveryCase {
    const noted = appendAudit(recoveryCase, { type: 'pre_existing_success', actor: 'provider', at: event.receivedAt, explanation: 'Success was not caused by a recovery action, so it is not recovered revenue', data: { eventId: event.id } });
    return this.settle(noted, 'stopped', event.receivedAt, 'The renewal was paid outside the recovery loop, so no action may be authorized');
  }

  private recordRetryFailure(recoveryCase: RecoveryCase, retry: RecoveryAction, event: ProviderEvent): RecoveryCase {
    const failed = updateAction(recoveryCase, retry.idempotencyKey, { status: 'failed', result: `Provider reported the retry failed: ${event.id}` }, event.receivedAt);
    const audited = appendAudit(failed, { type: 'retry_failed', actor: 'provider', at: event.receivedAt, explanation: 'The authorized retry did not collect the renewal', data: { eventId: event.id, action: retry.kind } });
    return this.stepDownToFallback(audited, event.receivedAt);
  }

  /**
   * Records the workflow's own recommendation after an unsuccessful retry. It is written as a
   * Diagnosis so policy still authorizes the next rung — ADR-0001 keeps policy the only
   * authorizer — but `modelVersion` marks it as workflow-authored rather than model output.
   */
  private stepDownToFallback(recoveryCase: RecoveryCase, at: string): RecoveryCase {
    const recommendation: Diagnosis = {
      failureCategory: 'transient', confidence: 1, evidence: ['retry_failed'], recommendedAction: 'fallback_link',
      explanation: 'Retry did not recover the renewal; offer an expiring fallback link.', modelVersion: 'workflow-v1',
    };
    return withDiagnosis(recoveryCase, recommendation, at);
  }

  /**
   * Carries a case to its next resting point: diagnose if it has no recommendation yet, ask
   * policy, then execute whatever policy authorized. Callers drive the loop with this rather
   * than sequencing the three steps themselves.
   */
  async drive(caseId: string): Promise<RecoveryCase> {
    const current = await this.requireCase(caseId);
    if (isTerminal(current.status)) return current;
    // A case resting on a submitted retry or a live link is waiting on the outside world, not on
    // us. Re-authorizing there would ask policy for a rung the case has already spent.
    const waiting = current.status === 'retry_scheduled' || current.status === 'fallback_link_available';
    if (waiting && !current.actions.some((action) => action.status === 'pending')) return current;
    if (!current.diagnosis) await this.runDiagnosis(caseId);
    await this.authorize(caseId);
    return this.executePending(caseId);
  }

  async runDiagnosis(caseId: string): Promise<RecoveryCase> {
    const current = await this.requireCase(caseId);
    if (isTerminal(current.status)) return current;
    const now = this.clock.now().toISOString();
    let produced: Diagnosis | undefined;
    let failing = current;
    // A transient model outage is retried a bounded number of times inside this run. Nothing
    // else re-drives a case, so exhausting the attempts must escalate rather than stall.
    for (let attempt = 1; attempt <= this.maxDiagnosisAttempts && produced === undefined; attempt += 1) {
      try {
        produced = await this.diagnosis.diagnose(failing);
      } catch (error) {
        const reason = error instanceof DiagnosisFailure ? error.message : `Diagnosis unavailable: ${error instanceof Error ? error.message : String(error)}`;
        const retryable = error instanceof DiagnosisFailure && error.retryable;
        failing = appendAudit(failing, { type: 'diagnosis_unavailable', actor: 'diagnosis_model', at: now, explanation: reason, data: { retryable, attempt } });
        if (!retryable || attempt === this.maxDiagnosisAttempts) {
          // Model failure must never authorize a money action: hand the case to a human.
          const escalated = this.escalateCase(failing, reason, now);
          await this.store.save(escalated);
          return escalated;
        }
        const advertised = error instanceof DiagnosisFailure ? error.retryAfterMilliseconds : undefined;
        await this.sleep(advertised ?? this.retryBackoffMilliseconds * attempt);
      }
    }
    if (produced === undefined) throw new Error('Diagnosis loop ended without a diagnosis');
    let updated = withDiagnosis(failing, produced, now);
    updated = appendAudit(updated, { type: 'diagnosis_created', actor: 'diagnosis_model', at: now, explanation: updated.diagnosis?.explanation ?? 'Diagnosis created', data: { modelVersion: updated.diagnosis?.modelVersion } });
    await this.store.save(updated);
    return updated;
  }

  async authorize(caseId: string): Promise<RecoveryCase> {
    const current = await this.requireCase(caseId);
    if (isTerminal(current.status)) return current;
    // No diagnosis means nothing was recommended; authorizing nothing is the safe outcome.
    if (!current.diagnosis) return current;
    const now = this.clock.now().toISOString();
    const decision = this.policy.decide(current, current.diagnosis, now);
    let updated = addDecision(current, decision);
    updated = appendAudit(updated, { type: decision.allowed ? 'policy_allowed' : 'policy_blocked', actor: 'policy', at: now, explanation: decision.reason, data: { action: decision.action, policyVersion: decision.policyVersion } });
    if (!decision.allowed) {
      updated = this.escalateCase(updated, decision.reason, now);
      await this.store.save(updated);
      return updated;
    }
    let kind = decision.action;
    if (kind === 'retry') {
      // Policy may approve a retry the provider cannot actually perform on this payment method.
      // The fallback link needs no mandate, so step down the ladder rather than discarding it.
      const eligibility = await this.provider.retryEligibility(current);
      if (!eligibility.eligible) {
        updated = appendAudit(updated, { type: 'retry_ineligible', actor: 'provider', at: now, explanation: eligibility.reason, data: { action: decision.action } });
        // Policy remains the only authorizer: ask it about the fallback link on its own terms.
        const steppedDown = this.policy.decide(current, { ...current.diagnosis, recommendedAction: 'fallback_link', explanation: eligibility.reason }, now);
        updated = addDecision(updated, steppedDown);
        updated = appendAudit(updated, { type: steppedDown.allowed ? 'policy_allowed' : 'policy_blocked', actor: 'policy', at: now, explanation: steppedDown.reason, data: { action: steppedDown.action, policyVersion: steppedDown.policyVersion } });
        if (!steppedDown.allowed) {
          updated = this.escalateCase(updated, steppedDown.reason, now);
          await this.store.save(updated);
          return updated;
        }
        kind = steppedDown.action;
      }
    }
    if (kind !== 'retry' && kind !== 'fallback_link') {
      // An allowed verdict that moves no money is an outcome, not a pending provider operation.
      const status = kind === 'stop' ? 'stopped' : 'escalated';
      updated = this.settle(updated, status, now, decision.reason);
      await this.store.save(updated);
      return updated;
    }
    const action: RecoveryAction = {
      id: `${caseId}:action:${kind}:${current.actions.length + 1}`,
      kind,
      status: 'pending',
      idempotencyKey: `${caseId}:${kind}`,
      createdAt: now,
    };
    updated = addAction(updated, action, now);
    if (kind === 'retry') updated = withStatus(updated, 'retry_scheduled', now);
    if (kind === 'fallback_link') updated = withStatus(updated, 'fallback_link_available', now);
    await this.store.save(updated);
    return updated;
  }

  async executePending(caseId: string): Promise<RecoveryCase> {
    const current = await this.requireCase(caseId);
    const action = current.actions.find((candidate) => candidate.status === 'pending');
    if (!action || isTerminal(current.status)) return current;
    const now = this.clock.now().toISOString();
    let updated = current;
    const result = action.kind === 'retry'
      ? await this.provider.submitRetry(current, action)
      : action.kind === 'fallback_link'
        ? await this.provider.createFallbackLink(current, action)
        : { status: 'succeeded' as const, message: 'Manual action completed' };
    const actionUpdate: Partial<RecoveryAction> = {
      status: result.status === 'failed' ? 'failed' : result.status === 'succeeded' ? 'succeeded' : 'submitted',
      ...(result.providerReference === undefined ? {} : { providerReference: result.providerReference }),
      result: result.message,
    };
    if ('expiresAt' in result && typeof result.expiresAt === 'string') {
      updated = updateAction(updated, action.idempotencyKey, { ...actionUpdate, expiresAt: result.expiresAt }, now);
    } else {
      updated = updateAction(updated, action.idempotencyKey, actionUpdate, now);
    }
    updated = appendAudit(updated, { type: 'provider_action_result', actor: 'provider', at: now, explanation: result.message, data: { action: action.kind, status: result.status, idempotencyKey: action.idempotencyKey } });
    if (result.status === 'failed') {
      if (action.kind === 'retry') {
        updated = this.stepDownToFallback(updated, now);
      } else if (action.kind === 'fallback_link') updated = this.settle(updated, 'exhausted', now, 'The fallback link could not be created');
    }
    await this.store.save(updated);
    return updated;
  }

  /**
   * Retires a fallback link the customer never paid. Nothing else closes the loop for a case
   * resting in `fallback_link_available`, so without this the renewal stays open forever.
   */
  async expireLapsedFallbackLink(caseId: string): Promise<RecoveryCase> {
    const current = await this.requireCase(caseId);
    if (isTerminal(current.status)) return current;
    const now = this.clock.now().toISOString();
    const lapsed = current.actions.find((action) =>
      action.kind === 'fallback_link' && action.status !== 'failed' && action.expiresAt !== undefined && Date.parse(action.expiresAt) <= Date.parse(now));
    if (!lapsed) return current;
    let updated = updateAction(current, lapsed.idempotencyKey, { status: 'failed', result: 'Fallback link expired before the renewal was paid' }, now);
    updated = appendAudit(updated, { type: 'fallback_link_expired', actor: 'system', at: now, explanation: 'The fallback link expired before the renewal was paid', data: { action: lapsed.kind, expiresAt: lapsed.expiresAt } });
    updated = this.settle(updated, 'exhausted', now, 'The fallback link expired before the renewal was paid');
    await this.store.save(updated);
    return updated;
  }

  async stop(caseId: string, reason = 'Stopped by recovery operator'): Promise<RecoveryCase> {
    return this.manualOutcome(caseId, 'stopped', 'manual_stop', reason);
  }

  async escalate(caseId: string, reason = 'Escalated by recovery operator'): Promise<RecoveryCase> {
    return this.manualOutcome(caseId, 'escalated', 'manual_escalation', reason);
  }

  /** Applies an operator's verdict, or records that the case had already reached an outcome. */
  private async manualOutcome(caseId: string, status: 'stopped' | 'escalated', auditType: 'manual_stop' | 'manual_escalation', reason: string): Promise<RecoveryCase> {
    const current = await this.requireCase(caseId);
    const now = this.clock.now().toISOString();
    // An outcome already reached is not the operator's to overwrite, but the attempt is auditable.
    const updated = isTerminal(current.status)
      ? appendAudit(current, { type: 'manual_action_ignored', actor: 'operator', at: now, explanation: `Case already reached ${current.status}; ${reason} was not applied`, data: { requested: status, status: current.status } })
      : this.settle(appendAudit(current, { type: auditType, actor: 'operator', at: now, explanation: reason, data: {} }), status, now, reason);
    await this.store.save(updated);
    return updated;
  }

  private async requireCase(id: string): Promise<RecoveryCase> {
    const recoveryCase = await this.store.get(id);
    if (!recoveryCase) throw new Error(`Recovery Case not found: ${id}`);
    return recoveryCase;
  }
}
