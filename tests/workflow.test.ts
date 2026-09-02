import { describe, expect, it } from 'vitest';
import type { Diagnosis, RecoveryCase } from '../src/domain.js';
import { DeterministicSimulator, FixedClock, type SimulatorScenario } from '../src/provider.js';
import { DeterministicPolicy, FixtureDiagnosisEngine, InMemoryRecoveryStore, RecoveryWorkflow, type DiagnosisEngine } from '../src/recovery.js';
import { DiagnosisUnavailableError } from '../src/diagnosis.js';

const context = {
  customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z',
};

function setup(diagnosis?: Diagnosis, scenario: SimulatorScenario = { retry: 'success', fallback: 'success', diagnosis: 'transient' }) {
  const store = new InMemoryRecoveryStore();
  const provider = new DeterministicSimulator(new Map([['case-1', scenario]]));
  const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(new Map(diagnosis ? [['case-1', diagnosis]] : [])), new DeterministicPolicy(), new FixedClock('2026-01-01T00:00:00.000Z'));
  return { workflow, provider };
}

async function failed(workflow: RecoveryWorkflow, provider: DeterministicSimulator) {
  await workflow.openCase('case-1', context);
  await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-1', type: 'payment_failed', caseId: 'case-1', occurredAt: '2026-01-01T00:00:00.000Z', payload: { method: 'recurring_mandate', failureCode: 'temporary' } }, '2026-01-01T00:00:01.000Z'));
}

describe('RecoveryWorkflow', () => {
  it('authorizes and executes one retry, then attributes correlated success', async () => {
    const { workflow, provider } = setup();
    await failed(workflow, provider);
    await workflow.runDiagnosis('case-1');
    expect((await workflow.authorize('case-1')).status).toBe('retry_scheduled');
    expect((await workflow.executePending('case-1')).actions[0]?.status).toBe('succeeded');
    const result = await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-2', type: 'payment_succeeded', caseId: 'case-1', providerPaymentId: 'sim_retry_case-1', occurredAt: '2026-01-01T00:00:02.000Z' }, '2026-01-01T00:00:03.000Z'));
    expect(result.status).toBe('recovered');
    expect(result.recoveredAmount).toBe(1200);
  });

  it('offers exactly one fallback link after a failed retry', async () => {
    const { workflow, provider } = setup(undefined, { retry: 'failure', fallback: 'success', diagnosis: 'transient' });
    await failed(workflow, provider);
    await workflow.runDiagnosis('case-1');
    await workflow.authorize('case-1');
    await workflow.executePending('case-1');
    expect((await workflow.authorize('case-1')).status).toBe('fallback_link_available');
    await workflow.executePending('case-1');
    const result = await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-3', type: 'payment_succeeded', caseId: 'case-1', providerPaymentId: 'pay_link_case-1', providerActionReference: 'sim_link_case-1', occurredAt: '2026-01-01T00:00:04.000Z' }, '2026-01-01T00:00:05.000Z'));
    expect(result.actions.filter((action) => action.kind === 'fallback_link')).toHaveLength(1);
    expect(result.status).toBe('recovered');
    expect(provider.calls).toHaveLength(2);
  });

  it('fails safe for low confidence and hard declines', async () => {
    const lowConfidence = { failureCategory: 'transient' as const, confidence: 0.2, evidence: ['signal'], recommendedAction: 'retry' as const, explanation: 'uncertain', modelVersion: 'test' };
    const low = setup(lowConfidence);
    await failed(low.workflow, low.provider);
    await low.workflow.runDiagnosis('case-1');
    expect((await low.workflow.authorize('case-1')).status).toBe('escalated');
    expect(low.provider.calls).toHaveLength(0);

    const hard = setup({ failureCategory: 'hard_decline', confidence: 0.99, evidence: ['decline'], recommendedAction: 'retry', explanation: 'hard decline', modelVersion: 'test' });
    await failed(hard.workflow, hard.provider);
    await hard.workflow.runDiagnosis('case-1');
    expect((await hard.workflow.authorize('case-1')).outcome).toBe('escalated');
  });

  it('offers the fallback link when the provider reports the retry ineligible', async () => {
    const store = new InMemoryRecoveryStore();
    const provider = new DeterministicSimulator(new Map([['case-1', { retry: 'unsupported', fallback: 'success', diagnosis: 'transient' }]]), new FixedClock('2026-01-01T00:00:00.000Z'));
    const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(), new DeterministicPolicy(), new FixedClock('2026-01-01T00:00:00.000Z'));
    await failed(workflow, provider);
    await workflow.runDiagnosis('case-1');

    const authorized = await workflow.authorize('case-1');

    expect(authorized.status).toBe('fallback_link_available');
    expect(authorized.actions.map((recoveryAction) => recoveryAction.kind)).toEqual(['fallback_link']);
    expect(authorized.audit.some((event) => event.type === 'retry_ineligible')).toBe(true);
    // Every executed action must carry its own policy authorization.
    expect(authorized.decisions.map((decision) => [decision.action, decision.allowed])).toEqual([['retry', true], ['fallback_link', true]]);
    expect((await workflow.executePending('case-1')).actions[0]?.status).toBe('succeeded');
    expect(provider.calls.map((call) => call.kind)).toEqual(['fallback_link']);
  });

  it('escalates when the retry is ineligible and the fallback link is already spent', async () => {
    const store = new InMemoryRecoveryStore();
    const provider = new DeterministicSimulator(new Map([['case-1', { retry: 'unsupported', fallback: 'failure', diagnosis: 'transient' }]]), new FixedClock('2026-01-01T00:00:00.000Z'));
    const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(), new DeterministicPolicy(), new FixedClock('2026-01-01T00:00:00.000Z'));
    await failed(workflow, provider);
    await workflow.runDiagnosis('case-1');
    await workflow.authorize('case-1');
    expect((await workflow.executePending('case-1')).status).toBe('exhausted');

    const reauthorized = await workflow.authorize('case-1');
    expect(reauthorized.actions.filter((recoveryAction) => recoveryAction.kind === 'fallback_link')).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    expect(reauthorized.status).toBe('exhausted');
  });

  it('applies an allowed non-actionable verdict as an outcome instead of a pending action', async () => {
    const cases: readonly { action: 'stop' | 'escalate'; status: string }[] = [{ action: 'escalate', status: 'escalated' }, { action: 'stop', status: 'stopped' }];
    for (const expected of cases) {
      const store = new InMemoryRecoveryStore();
      const provider = new DeterministicSimulator(new Map(), new FixedClock('2026-01-01T00:00:00.000Z'));
      const policy = {
        decide(_recoveryCase: RecoveryCase, _diagnosis: Diagnosis, now: string) {
          return { action: expected.action, allowed: true, reason: `policy chose ${expected.action}`, policyVersion: 'test', decidedAt: now };
        },
      };
      const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(), policy, new FixedClock('2026-01-01T00:00:00.000Z'));
      await failed(workflow, provider);
      await workflow.runDiagnosis('case-1');

      const authorized = await workflow.authorize('case-1');

      expect(authorized.status).toBe(expected.status);
      expect(authorized.actions).toHaveLength(0);
      expect(provider.calls).toHaveLength(0);
    }
  });

  it('records a policy rejection when the stepped-down fallback link is not allowed', async () => {
    const store = new InMemoryRecoveryStore();
    const provider = new DeterministicSimulator(new Map([['case-1', { retry: 'unsupported', fallback: 'success', diagnosis: 'transient' }]]), new FixedClock('2026-01-01T00:00:00.000Z'));
    const policy = {
      decide(_recoveryCase: RecoveryCase, diagnosis: Diagnosis, now: string) {
        return diagnosis.recommendedAction === 'retry'
          ? { action: 'retry' as const, allowed: true, reason: 'retry approved', policyVersion: 'test', decidedAt: now }
          : { action: 'fallback_link' as const, allowed: false, reason: 'fallback links are disabled for this merchant', policyVersion: 'test', decidedAt: now };
      },
    };
    const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(), policy, new FixedClock('2026-01-01T00:00:00.000Z'));
    await failed(workflow, provider);
    await workflow.runDiagnosis('case-1');

    const authorized = await workflow.authorize('case-1');

    expect(authorized.status).toBe('escalated');
    expect(authorized.actions).toHaveLength(0);
    expect(authorized.decisions.map((decision) => [decision.action, decision.allowed])).toEqual([['retry', true], ['fallback_link', false]]);
    expect(authorized.audit.some((event) => event.type === 'policy_blocked' && event.explanation.includes('disabled'))).toBe(true);
    expect(provider.calls).toHaveLength(0);
  });

  it('deduplicates events and blocks actions after terminal success', async () => {
    const { workflow, provider } = setup();
    await failed(workflow, provider);
    await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-1', type: 'payment_failed', caseId: 'case-1', occurredAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:01.000Z'));
    await workflow.runDiagnosis('case-1');
    await workflow.authorize('case-1');
    await workflow.executePending('case-1');
    await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-2', type: 'payment_succeeded', caseId: 'case-1', providerPaymentId: 'sim_retry_case-1', occurredAt: '2026-01-01T00:00:02.000Z' }, '2026-01-01T00:00:03.000Z'));
    expect((await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-2', type: 'payment_succeeded', caseId: 'case-1', providerPaymentId: 'sim_retry_case-1', occurredAt: '2026-01-01T00:00:02.000Z' }, '2026-01-01T00:00:04.000Z'))).status).toBe('recovered');
    expect(provider.calls).toHaveLength(1);
  });
});

describe('RecoveryWorkflow diagnosis fail-safe', () => {
  it('escalates without a money action when the diagnosis engine is unavailable', async () => {
    const store = new InMemoryRecoveryStore();
    const provider = new DeterministicSimulator(new Map([['case-1', { retry: 'success', fallback: 'success', diagnosis: 'transient' } as SimulatorScenario]]));
    const engine = { async diagnose(): Promise<Diagnosis> { throw new DiagnosisUnavailableError('model returned malformed output'); } };
    const workflow = new RecoveryWorkflow(store, provider, engine, new DeterministicPolicy(), new FixedClock('2026-01-01T00:00:00.000Z'));
    await failed(workflow, provider);

    const diagnosed = await workflow.runDiagnosis('case-1');

    expect(diagnosed.status).toBe('escalated');
    expect(diagnosed.diagnosis).toBeUndefined();
    expect(diagnosed.audit.some((event) => event.type === 'diagnosis_unavailable')).toBe(true);
    expect((await workflow.authorize('case-1')).actions).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });

  function engineOf(diagnose: (recoveryCase: RecoveryCase) => Promise<Diagnosis>) {
    const store = new InMemoryRecoveryStore();
    const provider = new DeterministicSimulator(new Map([['case-1', { retry: 'success', fallback: 'success', diagnosis: 'transient' } as SimulatorScenario]]));
    const delays: number[] = [];
    const workflow = new RecoveryWorkflow(store, provider, { diagnose }, new DeterministicPolicy(), new FixedClock('2026-01-01T00:00:00.000Z'), {
      maxDiagnosisAttempts: 3,
      sleep: async (milliseconds: number) => { delays.push(milliseconds); },
    });
    return { workflow, provider, delays };
  }

  it('backs off between diagnosis attempts and honours an advertised retry-after', async () => {
    let attempts = 0;
    const { workflow, provider, delays } = engineOf(async () => {
      attempts += 1;
      throw new DiagnosisUnavailableError('model returned HTTP 429', { retryable: true, ...(attempts === 1 ? { retryAfterMilliseconds: 2500 } : {}) });
    });
    await failed(workflow, provider);

    await workflow.runDiagnosis('case-1');

    expect(delays).toEqual([2500, 2000]);
  });

  it('rejects a workflow configured with no diagnosis attempts', () => {
    const store = new InMemoryRecoveryStore();
    const provider = new DeterministicSimulator();
    expect(() => new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(), new DeterministicPolicy(), new FixedClock('2026-01-01T00:00:00.000Z'), { maxDiagnosisAttempts: 0 })).toThrow(/maxDiagnosisAttempts/);
  });

  it('retries a transient model outage within one diagnosis run', async () => {
    let attempts = 0;
    const { workflow, provider } = engineOf(async (recoveryCase) => {
      attempts += 1;
      if (attempts === 1) throw new DiagnosisUnavailableError('model returned HTTP 429', { retryable: true });
      return { failureCategory: 'transient', confidence: 0.9, evidence: [recoveryCase.events[0]?.id ?? 'event-1'], recommendedAction: 'retry', explanation: 'recoverable', modelVersion: 'test' };
    });
    await failed(workflow, provider);

    const diagnosed = await workflow.runDiagnosis('case-1');

    expect(attempts).toBe(2);
    expect(diagnosed.status).toBe('diagnosed');
    expect(diagnosed.audit.filter((event) => event.type === 'diagnosis_unavailable')).toHaveLength(1);
    expect((await workflow.authorize('case-1')).status).toBe('retry_scheduled');
  });

  it('escalates rather than stalling when every diagnosis attempt is a transient outage', async () => {
    let attempts = 0;
    const { workflow, provider } = engineOf(async () => {
      attempts += 1;
      throw new DiagnosisUnavailableError('model returned HTTP 503', { retryable: true });
    });
    await failed(workflow, provider);

    const result = await workflow.runDiagnosis('case-1');

    expect(attempts).toBe(3);
    expect(result.status).toBe('escalated');
    expect(result.diagnosis).toBeUndefined();
    expect(result.audit.filter((event) => event.type === 'diagnosis_unavailable')).toHaveLength(3);
    expect(provider.calls).toHaveLength(0);
  });

  it('authorizes nothing when a case has no diagnosis instead of throwing', async () => {
    const { workflow, provider } = engineOf(async () => { throw new DiagnosisUnavailableError('model returned HTTP 429', { retryable: true }); });
    await failed(workflow, provider);
    await workflow.runDiagnosis('case-1');

    const authorized = await workflow.authorize('case-1');

    expect(authorized.actions).toHaveLength(0);
    expect(authorized.decisions).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
    expect(await workflow.executePending('case-1')).toBeDefined();
  });

  it('escalates a terminal model failure even from a mid-flight status', async () => {
    const store = new InMemoryRecoveryStore();
    const provider = new DeterministicSimulator(new Map([['case-1', { retry: 'failure', fallback: 'success', diagnosis: 'transient' } as SimulatorScenario]]));
    let calls = 0;
    const engine = {
      async diagnose(recoveryCase: RecoveryCase): Promise<Diagnosis> {
        calls += 1;
        if (calls === 1) return { failureCategory: 'transient', confidence: 0.9, evidence: [recoveryCase.events[0]?.id ?? 'event-1'], recommendedAction: 'retry', explanation: 'recoverable', modelVersion: 'test' };
        throw new DiagnosisUnavailableError('model output is not an object');
      },
    };
    const workflow = new RecoveryWorkflow(store, provider, engine, new DeterministicPolicy(), new FixedClock('2026-01-01T00:00:00.000Z'));
    await failed(workflow, provider);
    await workflow.runDiagnosis('case-1');
    expect((await workflow.authorize('case-1')).status).toBe('retry_scheduled');

    const result = await workflow.runDiagnosis('case-1');

    expect(result.status).toBe('escalated');
    expect(result.audit.some((event) => event.type === 'diagnosis_unavailable')).toBe(true);
  });

  it('fails safe when the model resolves no diagnosis instead of one', async () => {
    const store = new InMemoryRecoveryStore();
    const provider = new DeterministicSimulator(new Map([['case-1', { retry: 'success', fallback: 'success', diagnosis: 'transient' } as SimulatorScenario]]));
    const silent = { diagnose: async () => undefined } as unknown as DiagnosisEngine;
    const workflow = new RecoveryWorkflow(store, provider, silent, new DeterministicPolicy(), new FixedClock('2026-01-01T00:00:00.000Z'), { maxDiagnosisAttempts: 2, sleep: async () => undefined });
    await failed(workflow, provider);

    await expect(workflow.drive('case-1')).rejects.toThrow(/ended without a diagnosis/);
  });

  it('still attributes a correlated success after the case was escalated', async () => {
    const { workflow, provider } = setup(undefined, { retry: 'success', fallback: 'success', diagnosis: 'transient' });
    await failed(workflow, provider);
    await workflow.runDiagnosis('case-1');
    await workflow.authorize('case-1');
    await workflow.executePending('case-1');
    const escalated = await workflow.escalate('case-1', 'operator took over');
    expect(escalated.status).toBe('escalated');

    // The operator gave up on the case, but the retry the provider had already accepted settles.
    const result = await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-9', type: 'payment_succeeded', caseId: 'case-1', providerPaymentId: 'sim_retry_case-1', occurredAt: '2026-01-01T00:00:06.000Z' }, '2026-01-01T00:00:07.000Z'));

    expect(result.status).toBe('recovered');
    expect(result.recoveredAmount).toBe(1200);
    expect(result.recoveryAttribution).toMatchObject({ actionKind: 'retry', idempotencyKey: 'case-1:retry', providerReference: 'sim_retry_case-1', providerPaymentId: 'sim_retry_case-1', eventId: 'event-9' });
  });
});

/**
 * Recovered Revenue is counted only through explicit correlation, so this is the whole matrix of
 * what a `payment_succeeded` delivery may and may not claim. Each row is a different piece of
 * evidence the provider supplied; only the ones that actually name an authorized, executed action
 * are allowed to move money into the recovered figure.
 */
describe('success attribution', () => {
  async function retriedCase(scenario?: SimulatorScenario) {
    const { workflow, provider } = setup(undefined, scenario);
    await failed(workflow, provider);
    await workflow.runDiagnosis('case-1');
    await workflow.authorize('case-1');
    await workflow.executePending('case-1');
    return { workflow, provider };
  }

  function success(id: string, occurredAt: string, correlation: { providerPaymentId?: string; providerActionReference?: string }) {
    return { id, type: 'payment_succeeded' as const, caseId: 'case-1', occurredAt, ...correlation };
  }

  it('names the action, the payment, and the event behind every recovered figure', async () => {
    const { workflow, provider } = await retriedCase();

    const result = await workflow.ingestEvent(provider.normalizeEvent(success('event-success', '2026-01-01T00:00:02.000Z', { providerPaymentId: 'sim_retry_case-1' }), '2026-01-01T00:00:03.000Z'));

    expect(result.recoveryAttribution).toMatchObject({
      actionId: expect.any(String),
      actionKind: 'retry',
      idempotencyKey: 'case-1:retry',
      providerReference: 'sim_retry_case-1',
      providerPaymentId: 'sim_retry_case-1',
      eventId: 'event-success',
    });
  });

  it('refuses a payment that names no action on the case', async () => {
    const { workflow, provider } = await retriedCase();

    const result = await workflow.ingestEvent(provider.normalizeEvent(success('event-success', '2026-01-01T00:00:02.000Z', { providerPaymentId: 'pay_somebody_else' }), '2026-01-01T00:00:03.000Z'));

    // The renewal is paid, so the loop stands down — but the money is not ours to claim.
    expect(result.status).toBe('stopped');
    expect(result.recoveredAmount).toBe(0);
    expect(result.recoveryAttribution).toBeUndefined();
  });

  it('refuses a payment that settled before the action existed', async () => {
    const { workflow, provider } = await retriedCase();

    const result = await workflow.ingestEvent(provider.normalizeEvent(success('event-success', '2025-12-31T23:59:59.000Z', { providerPaymentId: 'sim_retry_case-1' }), '2026-01-01T00:00:03.000Z'));

    expect(result.status).toBe('stopped');
    expect(result.recoveredAmount).toBe(0);
  });

  it('records a payment it cannot claim without disturbing a case that already ended', async () => {
    const { workflow, provider } = await retriedCase({ retry: 'failure', fallback: 'failure', diagnosis: 'transient' });
    const exhausted = await workflow.drive('case-1');
    expect(exhausted.status).toBe('exhausted');

    const result = await workflow.ingestEvent(provider.normalizeEvent(success('event-success', '2026-01-01T00:00:09.000Z', { providerPaymentId: 'pay_somebody_else' }), '2026-01-01T00:00:10.000Z'));

    expect(result.status).toBe('exhausted');
    expect(result.recoveredAmount).toBe(0);
    expect(result.audit.map((entry) => entry.type)).toContain('uncorrelated_success');
  });
});

describe('RecoveryWorkflow fail-safes for a case nobody opened', () => {
  it('refuses to ingest a delivery for a case that was never registered', async () => {
    const { workflow, provider } = setup();

    const event = provider.normalizeEvent({ id: 'event-ghost', type: 'payment_failed', caseId: 'case-ghost', occurredAt: '2026-01-01T00:00:00.000Z', payload: { method: 'recurring_mandate' } }, '2026-01-01T00:00:01.000Z');

    await expect(workflow.ingestAndDrive(event)).rejects.toThrow('Recovery Case not found: case-ghost');
  });

  it('refuses an operator stop for a case that was never registered', async () => {
    const { workflow } = setup();

    await expect(workflow.stop('case-ghost')).rejects.toThrow('Recovery Case not found: case-ghost');
  });

  it('refuses an operator escalation for a case that was never registered', async () => {
    const { workflow } = setup();

    await expect(workflow.escalate('case-ghost')).rejects.toThrow('Recovery Case not found: case-ghost');
  });

  it('refuses to drive a case that was never registered', async () => {
    const { workflow } = setup();

    await expect(workflow.drive('case-ghost')).rejects.toThrow('Recovery Case not found: case-ghost');
  });
});
