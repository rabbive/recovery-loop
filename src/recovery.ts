import {
  addAction,
  addAttempt,
  addDecision,
  addProviderEvent,
  appendAudit,
  createRecoveryCase,
  isTerminal,
  markRecovered,
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

export interface DiagnosisEngine {
  diagnose(recoveryCase: RecoveryCase): Diagnosis;
}

export class FixtureDiagnosisEngine implements DiagnosisEngine {
  constructor(private readonly diagnosisByCase = new Map<string, Diagnosis>()) {}

  diagnose(recoveryCase: RecoveryCase): Diagnosis {
    return this.diagnosisByCase.get(recoveryCase.id) ?? {
      failureCategory: 'transient',
      confidence: 0.95,
      evidence: recoveryCase.events.map((event) => event.id),
      recommendedAction: 'retry',
      explanation: 'The failed renewal has an authorized recurring mandate and no terminal signal.',
      modelVersion: 'fixture-v1',
    };
  }
}

export interface Policy {
  decide(recoveryCase: RecoveryCase, diagnosis: Diagnosis, now: string): PolicyDecision;
}

export class DeterministicPolicy implements Policy {
  constructor(private readonly minimumConfidence = 0.75) {}

  decide(recoveryCase: RecoveryCase, diagnosis: Diagnosis, now: string): PolicyDecision {
    const reject = (action: ActionKind, reason: string): PolicyDecision => ({
      action,
      allowed: false,
      reason,
      policyVersion: 'policy-v1',
      decidedAt: now,
    });

    if (isTerminal(recoveryCase.status)) return reject(diagnosis.recommendedAction, 'Case is terminal');
    if (diagnosis.confidence < this.minimumConfidence) return reject('escalate', 'Diagnosis confidence is below policy threshold');
    if (diagnosis.failureCategory === 'hard_decline' || diagnosis.failureCategory === 'cancelled' || diagnosis.failureCategory === 'dispute') {
      return reject('escalate', `Failure category ${diagnosis.failureCategory} is not safe to automate`);
    }
    if (diagnosis.failureCategory === 'unknown' || diagnosis.failureCategory === 'unsupported') return reject('escalate', 'Failure category is unsupported');
    if (diagnosis.recommendedAction === 'retry') {
      if (recoveryCase.actions.some((action) => action.kind === 'retry')) return reject('escalate', 'Retry limit has been reached');
      return { action: 'retry', allowed: true, reason: 'Diagnosis recommends a bounded retry and policy checks passed', policyVersion: 'policy-v1', decidedAt: now };
    }
    if (diagnosis.recommendedAction === 'fallback_link') {
      if (recoveryCase.actions.some((action) => action.kind === 'fallback_link')) return reject('escalate', 'Fallback-link limit has been reached');
      return { action: 'fallback_link', allowed: true, reason: 'Fallback link is the next bounded action', policyVersion: 'policy-v1', decidedAt: now };
    }
    if (diagnosis.recommendedAction === 'stop') return reject('stop', 'Diagnosis requested stop; human confirmation is required');
    return reject('escalate', 'Diagnosis requested escalation');
  }
}

export interface RecoveryStore {
  get(id: string): RecoveryCase | undefined;
  save(recoveryCase: RecoveryCase): void;
  all(): RecoveryCase[];
}

export class InMemoryRecoveryStore implements RecoveryStore {
  private readonly cases = new Map<string, RecoveryCase>();
  get(id: string): RecoveryCase | undefined { return this.cases.get(id); }
  save(recoveryCase: RecoveryCase): void { this.cases.set(recoveryCase.id, recoveryCase); }
  all(): RecoveryCase[] { return [...this.cases.values()]; }
}

export class RecoveryWorkflow {
  constructor(
    private readonly store: RecoveryStore,
    private readonly provider: PaymentProvider,
    private readonly diagnosis: DiagnosisEngine,
    private readonly policy: Policy,
    private readonly clock: Clock,
  ) {}

  openCase(id: string, context: Parameters<typeof createRecoveryCase>[1]): RecoveryCase {
    const now = this.clock.now().toISOString();
    const recoveryCase = appendAudit(createRecoveryCase(id, context, now), {
      type: 'case_opened', actor: 'system', at: now, explanation: 'Recovery Case opened for a failed renewal', data: { orderId: context.orderId },
    });
    this.store.save(recoveryCase);
    return recoveryCase;
  }

  ingestEvent(event: ProviderEvent): RecoveryCase {
    const current = this.requireCase(event.caseId);
    if (current.events.some((existing) => existing.id === event.id)) return current;
    let updated = addProviderEvent(current, event);
    updated = appendAudit(updated, { type: 'provider_event_received', actor: 'provider', at: event.receivedAt, explanation: `Received ${event.type}`, data: { eventId: event.id } });
    if (event.type === 'payment_failed' && current.attempts.length === 0) {
      const attempt: PaymentAttempt = {
        id: `${current.id}:attempt:1`,
        providerPaymentId: event.providerPaymentId ?? `${current.id}:payment`,
        method: event.payload.method === 'recurring_mandate' ? 'recurring_mandate' : 'card',
        status: 'failed',
        ...(typeof event.payload.failureCode === 'string' ? { failureCode: event.payload.failureCode } : {}),
        occurredAt: event.occurredAt,
      };
      updated = addAttempt(updated, attempt);
    }
    if (event.type === 'payment_succeeded' && !isTerminal(current.status)) {
      const recoveryAction = current.actions.find((action) => action.kind === 'retry' || action.kind === 'fallback_link');
      if (recoveryAction) updated = markRecovered(updated, event.occurredAt);
      else updated = appendAudit(updated, { type: 'pre_existing_success', actor: 'provider', at: event.receivedAt, explanation: 'Success was not caused by a recovery action', data: { eventId: event.id } });
    }
    if (event.type === 'subscription_cancelled' || event.type === 'dispute_opened') {
      updated = withStatus(updated, 'escalated', event.receivedAt, 'escalated');
    }
    this.store.save(updated);
    return updated;
  }

  runDiagnosis(caseId: string): RecoveryCase {
    const current = this.requireCase(caseId);
    if (isTerminal(current.status)) return current;
    const now = this.clock.now().toISOString();
    let updated = withDiagnosis(current, this.diagnosis.diagnose(current), now);
    updated = appendAudit(updated, { type: 'diagnosis_created', actor: 'diagnosis_model', at: now, explanation: updated.diagnosis?.explanation ?? 'Diagnosis created', data: { modelVersion: updated.diagnosis?.modelVersion } });
    this.store.save(updated);
    return updated;
  }

  authorize(caseId: string): RecoveryCase {
    const current = this.requireCase(caseId);
    if (isTerminal(current.status)) return current;
    if (!current.diagnosis) throw new Error('Cannot authorize a case without diagnosis');
    const now = this.clock.now().toISOString();
    const decision = this.policy.decide(current, current.diagnosis, now);
    let updated = addDecision(current, decision);
    updated = appendAudit(updated, { type: decision.allowed ? 'policy_allowed' : 'policy_blocked', actor: 'policy', at: now, explanation: decision.reason, data: { action: decision.action, policyVersion: decision.policyVersion } });
    if (!decision.allowed) {
      updated = withStatus(updated, 'escalated', now, 'escalated');
      this.store.save(updated);
      return updated;
    }
    const action: RecoveryAction = {
      id: `${caseId}:action:${decision.action}:${current.actions.length + 1}`,
      kind: decision.action,
      status: 'pending',
      idempotencyKey: `${caseId}:${decision.action}`,
      createdAt: now,
    };
    updated = addAction(updated, action, now);
    if (decision.action === 'retry') updated = withStatus(updated, 'retry_scheduled', now);
    if (decision.action === 'fallback_link') updated = withStatus(updated, 'fallback_link_available', now);
    this.store.save(updated);
    return updated;
  }

  executePending(caseId: string): RecoveryCase {
    const current = this.requireCase(caseId);
    const action = current.actions.find((candidate) => candidate.status === 'pending');
    if (!action || isTerminal(current.status)) return current;
    const now = this.clock.now().toISOString();
    let updated = current;
    const result = action.kind === 'retry'
      ? this.provider.submitRetry(current, action)
      : action.kind === 'fallback_link'
        ? this.provider.createFallbackLink(current, action)
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
        const fallbackDiagnosis: Diagnosis = { failureCategory: 'transient', confidence: 1, evidence: ['retry_failed'], recommendedAction: 'fallback_link', explanation: 'Retry did not recover the renewal; offer an expiring fallback link.', modelVersion: 'workflow-v1' };
        updated = withDiagnosis(updated, fallbackDiagnosis, now);
      } else if (action.kind === 'fallback_link') updated = withStatus(updated, 'exhausted', now, 'exhausted');
    }
    this.store.save(updated);
    return updated;
  }

  stop(caseId: string, reason = 'Stopped by recovery operator'): RecoveryCase {
    const current = this.requireCase(caseId);
    const now = this.clock.now().toISOString();
    let updated = withStatus(current, 'stopped', now, 'stopped');
    updated = appendAudit(updated, { type: 'manual_stop', actor: 'operator', at: now, explanation: reason, data: {} });
    this.store.save(updated);
    return updated;
  }

  escalate(caseId: string, reason = 'Escalated by recovery operator'): RecoveryCase {
    const current = this.requireCase(caseId);
    const now = this.clock.now().toISOString();
    let updated = withStatus(current, 'escalated', now, 'escalated');
    updated = appendAudit(updated, { type: 'manual_escalation', actor: 'operator', at: now, explanation: reason, data: {} });
    this.store.save(updated);
    return updated;
  }

  private requireCase(id: string): RecoveryCase {
    const recoveryCase = this.store.get(id);
    if (!recoveryCase) throw new Error(`Recovery Case not found: ${id}`);
    return recoveryCase;
  }
}
