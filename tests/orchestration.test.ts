import { describe, expect, it } from 'vitest';
import type { RecoveryCase } from '../src/domain.js';
import { DeterministicSimulator, FixedClock, type SimulatorScenario } from '../src/provider.js';
import { DeterministicPolicy, FixtureDiagnosisEngine, InMemoryRecoveryStore, RecoveryWorkflow, type RecoveryStore } from '../src/recovery.js';

const context = { customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z' };

/** A store that can drop exactly one write, standing in for a process that dies mid-action. */
class CrashingStore implements RecoveryStore {
  private readonly inner = new InMemoryRecoveryStore();
  crashOnNextSave = false;
  async get(id: string): Promise<RecoveryCase | undefined> { return this.inner.get(id); }
  async all(): Promise<RecoveryCase[]> { return this.inner.all(); }
  async save(recoveryCase: RecoveryCase): Promise<void> {
    if (this.crashOnNextSave) {
      this.crashOnNextSave = false;
      throw new Error('process died before the action result was persisted');
    }
    await this.inner.save(recoveryCase);
  }
}

function setup(scenario: SimulatorScenario = { retry: 'success', fallback: 'success', diagnosis: 'transient' }, store: RecoveryStore = new InMemoryRecoveryStore()) {
  const clock = new FixedClock('2026-01-01T00:00:00.000Z');
  const provider = new DeterministicSimulator(new Map([['case-1', scenario]]), clock);
  const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(), new DeterministicPolicy(), clock);
  return { workflow, provider, store, clock };
}

async function openFailedCase(workflow: RecoveryWorkflow, provider: DeterministicSimulator) {
  await workflow.openCase('case-1', context);
  await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-1', type: 'payment_failed', caseId: 'case-1', occurredAt: '2026-01-01T00:00:00.000Z', payload: { method: 'recurring_mandate' } }, '2026-01-01T00:00:01.000Z'));
}

/**
 * Drives the loop to its next resting point. Only the first leg diagnoses: after a failed retry
 * the workflow already holds the fallback recommendation, so re-diagnosing would discard it.
 */
async function advance(workflow: RecoveryWorkflow, diagnose = false): Promise<RecoveryCase> {
  if (diagnose) await workflow.runDiagnosis('case-1');
  await workflow.authorize('case-1');
  return workflow.executePending('case-1');
}

describe('recovery orchestration', () => {
  it('walks a case from failure to recovery through exactly one retry', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);

    await advance(workflow, true);
    const recovered = await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-2', type: 'payment_succeeded', caseId: 'case-1', occurredAt: '2026-01-01T00:00:05.000Z' }, '2026-01-01T00:00:06.000Z'));

    expect(recovered.status).toBe('recovered');
    expect(provider.calls.map((call) => call.kind)).toEqual(['retry']);
  });

  it('bounds a case to one retry and one fallback link before exhausting it', async () => {
    const { workflow, provider } = setup({ retry: 'failure', fallback: 'failure', diagnosis: 'transient' });
    await openFailedCase(workflow, provider);

    await advance(workflow, true);
    const exhausted = await advance(workflow);

    expect(exhausted.status).toBe('exhausted');
    expect(exhausted.outcome).toBe('exhausted');
    expect(provider.calls.map((call) => call.kind)).toEqual(['retry', 'fallback_link']);
    expect(await workflow.authorize('case-1')).toMatchObject({ status: 'exhausted' });
    expect(provider.calls).toHaveLength(2);
  });

  it('does not repeat a provider action when the process died before the result was stored', async () => {
    const store = new CrashingStore();
    const { workflow, provider } = setup({ retry: 'success', fallback: 'success', diagnosis: 'transient' }, store);
    await openFailedCase(workflow, provider);
    await workflow.runDiagnosis('case-1');
    await workflow.authorize('case-1');

    store.crashOnNextSave = true;
    await expect(workflow.executePending('case-1')).rejects.toThrow(/process died/);
    // The action is still pending, so a restarted process re-drives it.
    expect((await store.get('case-1'))?.actions[0]?.status).toBe('pending');

    const resumed = await workflow.executePending('case-1');

    expect(resumed.actions[0]?.status).toBe('succeeded');
    expect(provider.calls).toHaveLength(1);
  });

  it('records the fallback link with the expiry the provider granted', async () => {
    const { workflow, provider } = setup({ retry: 'failure', fallback: 'success', diagnosis: 'transient' });
    await openFailedCase(workflow, provider);
    await advance(workflow, true);

    const linked = await advance(workflow);

    expect(linked.status).toBe('fallback_link_available');
    expect(linked.actions.find((action) => action.kind === 'fallback_link')?.expiresAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('exhausts a case whose fallback link lapsed without payment', async () => {
    const { workflow, provider, clock } = setup({ retry: 'failure', fallback: 'success', diagnosis: 'transient' });
    await openFailedCase(workflow, provider);
    await advance(workflow, true);
    await advance(workflow);

    expect((await workflow.expireLapsedActions('case-1')).status).toBe('fallback_link_available');
    clock.advance(24 * 60 * 60 * 1000);
    const expired = await workflow.expireLapsedActions('case-1');

    expect(expired.status).toBe('exhausted');
    expect(expired.actions.find((action) => action.kind === 'fallback_link')?.status).toBe('failed');
    expect(expired.audit.map((entry) => entry.type)).toContain('fallback_link_expired');
  });

  it('still reconciles a payment that lands after the link expired', async () => {
    const { workflow, provider, clock } = setup({ retry: 'failure', fallback: 'success', diagnosis: 'transient' });
    await openFailedCase(workflow, provider);
    await advance(workflow, true);
    await advance(workflow);
    clock.advance(24 * 60 * 60 * 1000);
    await workflow.expireLapsedActions('case-1');

    const recovered = await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-9', type: 'payment_succeeded', caseId: 'case-1', occurredAt: '2026-01-02T00:00:01.000Z' }, '2026-01-02T00:00:02.000Z'));

    expect(recovered.status).toBe('recovered');
    expect(recovered.recoveredAmount).toBe(1200);
  });

  it('lets an operator stop a live case and blocks every later action', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);
    await workflow.runDiagnosis('case-1');

    const stopped = await workflow.stop('case-1', 'merchant asked us to hold');

    expect(stopped.status).toBe('stopped');
    expect(stopped.outcome).toBe('stopped');
    expect((await workflow.authorize('case-1')).actions).toHaveLength(0);
    expect((await workflow.executePending('case-1')).actions).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
    expect(stopped.audit.map((entry) => entry.type)).toContain('manual_stop');
  });

  it('audits a manual stop that arrives after the renewal was already recovered', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);
    await advance(workflow, true);
    await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-2', type: 'payment_succeeded', caseId: 'case-1', occurredAt: '2026-01-01T00:00:05.000Z' }, '2026-01-01T00:00:06.000Z'));

    const stopped = await workflow.stop('case-1');

    expect(stopped.status).toBe('recovered');
    expect(stopped.audit.map((entry) => entry.type)).toContain('manual_action_ignored');
  });

  it('audits a manual escalation that arrives after the renewal was already recovered', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);
    await advance(workflow, true);
    await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-2', type: 'payment_succeeded', caseId: 'case-1', occurredAt: '2026-01-01T00:00:05.000Z' }, '2026-01-01T00:00:06.000Z'));

    const escalated = await workflow.escalate('case-1');

    expect(escalated.status).toBe('recovered');
    expect(escalated.audit.map((entry) => entry.type)).toContain('manual_action_ignored');
  });

  it('leaves an auditable trail of every input, recommendation, decision, result, and outcome', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);
    await advance(workflow, true);
    const recovered = await workflow.ingestEvent(provider.normalizeEvent({ id: 'event-2', type: 'payment_succeeded', caseId: 'case-1', occurredAt: '2026-01-01T00:00:05.000Z' }, '2026-01-01T00:00:06.000Z'));

    expect(recovered.audit.map((entry) => entry.type)).toEqual([
      'case_opened',
      'provider_event_received',
      'diagnosis_created',
      'policy_allowed',
      'provider_action_result',
      'provider_event_received',
    ]);
    expect(recovered.audit.map((entry) => entry.id)).toEqual(recovered.audit.map((_entry, index) => `case-1:audit:${index + 1}`));
    expect(recovered.decisions).toHaveLength(1);
  });
});
