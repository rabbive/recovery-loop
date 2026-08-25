import { describe, expect, it } from 'vitest';
import { DeterministicSimulator, FixedClock, type SimulatorScenario } from '../src/provider.js';
import { DeterministicPolicy, FixtureDiagnosisEngine, InMemoryRecoveryStore, RecoveryWorkflow } from '../src/recovery.js';

const context = { customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z' };

function setup(scenario: SimulatorScenario = { retry: 'success', fallback: 'success', diagnosis: 'transient' }) {
  const clock = new FixedClock('2026-01-01T00:00:00.000Z');
  const store = new InMemoryRecoveryStore();
  const provider = new DeterministicSimulator(new Map([['case-1', scenario]]), clock);
  const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(), new DeterministicPolicy(), clock);
  return { workflow, provider, store, clock };
}

function event(id: string, type: 'payment_failed' | 'payment_succeeded' | 'subscription_cancelled', occurredAt: string, payload: Record<string, unknown> = {}) {
  return { id, type, caseId: 'case-1', occurredAt, payload };
}

async function openFailedCase(workflow: RecoveryWorkflow, provider: DeterministicSimulator) {
  await workflow.openCase('case-1', context);
  await workflow.ingestEvent(provider.normalizeEvent(event('event-1', 'payment_failed', '2026-01-01T00:00:00.000Z', { method: 'recurring_mandate' }), '2026-01-01T00:00:01.000Z'));
}

describe('a renewal paid outside the loop', () => {
  it('stops the case so no recovery action is ever authorized against it', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);

    const paid = await workflow.ingestEvent(provider.normalizeEvent(event('event-2', 'payment_succeeded', '2026-01-01T00:00:02.000Z'), '2026-01-01T00:00:03.000Z'));

    expect(paid.status).toBe('stopped');
    expect(paid.recoveredAmount).toBe(0);
    expect(paid.audit.map((entry) => entry.type)).toContain('pre_existing_success');
  });

  it('refuses to retry a renewal that was already paid outside the loop', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);
    await workflow.ingestEvent(provider.normalizeEvent(event('event-2', 'payment_succeeded', '2026-01-01T00:00:02.000Z'), '2026-01-01T00:00:03.000Z'));

    await workflow.runDiagnosis('case-1');
    const authorized = await workflow.authorize('case-1');
    await workflow.executePending('case-1');

    expect(authorized.actions).toHaveLength(0);
    expect(provider.calls).toHaveLength(0);
  });
});

describe('retry result correlation', () => {
  it('steps down to the fallback link when the retry fails asynchronously', async () => {
    // The Razorpay adapter answers `submitted`, so the real outcome only arrives as a webhook.
    const { workflow, provider, store } = setup();
    await openFailedCase(workflow, provider);
    await workflow.runDiagnosis('case-1');
    await workflow.authorize('case-1');
    await workflow.executePending('case-1');
    const submitted = await store.get('case-1');
    await store.save({ ...submitted!, actions: submitted!.actions.map((action) => ({ ...action, status: 'submitted' as const })) });

    const failedRetry = await workflow.ingestEvent(provider.normalizeEvent(event('event-2', 'payment_failed', '2026-01-01T00:00:05.000Z', { method: 'recurring_mandate' }), '2026-01-01T00:00:06.000Z'));

    expect(failedRetry.actions[0]?.status).toBe('failed');
    expect(failedRetry.status).toBe('diagnosed');
    expect(failedRetry.audit.map((entry) => entry.type)).toContain('retry_failed');
    expect((await workflow.authorize('case-1')).status).toBe('fallback_link_available');
  });

  it('audits a repeat failure that correlates to no outstanding action', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);

    const repeat = await workflow.ingestEvent(provider.normalizeEvent(event('event-2', 'payment_failed', '2026-01-01T00:00:02.000Z', { method: 'recurring_mandate' }), '2026-01-01T00:00:03.000Z'));

    expect(repeat.attempts).toHaveLength(1);
    expect(repeat.audit.map((entry) => entry.type)).toContain('late_event_ignored');
  });
});

describe('outcome auditing', () => {
  it('records reaching recovered in the audit timeline', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);
    await workflow.runDiagnosis('case-1');
    await workflow.authorize('case-1');
    await workflow.executePending('case-1');

    const recovered = await workflow.ingestEvent(provider.normalizeEvent(event('event-2', 'payment_succeeded', '2026-01-01T00:00:05.000Z'), '2026-01-01T00:00:06.000Z'));

    expect(recovered.audit.map((entry) => entry.type)).toContain('case_recovered');
    expect(recovered.audit.at(-1)?.data).toMatchObject({ recoveredAmount: 1200 });
  });

  it('records the escalation a cancellation forces', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);

    const cancelled = await workflow.ingestEvent(provider.normalizeEvent(event('event-2', 'subscription_cancelled', '2026-01-01T00:00:02.000Z'), '2026-01-01T00:00:03.000Z'));

    expect(cancelled.status).toBe('escalated');
    expect(cancelled.audit.map((entry) => entry.type)).toContain('case_escalated');
  });
});

describe('driving the loop', () => {
  it('carries a freshly opened case to its next resting point in one call', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);

    const driven = await workflow.drive('case-1');

    expect(driven.status).toBe('retry_scheduled');
    expect(driven.actions.map((action) => `${action.kind}:${action.status}`)).toEqual(['retry:succeeded']);
    expect(provider.calls.map((call) => call.kind)).toEqual(['retry']);
  });

  it('drives a failed retry down to the fallback link without re-diagnosing', async () => {
    const { workflow, provider } = setup({ retry: 'failure', fallback: 'success', diagnosis: 'transient' });
    await openFailedCase(workflow, provider);

    await workflow.drive('case-1');
    const linked = await workflow.drive('case-1');

    expect(linked.status).toBe('fallback_link_available');
    expect(provider.calls.map((call) => call.kind)).toEqual(['retry', 'fallback_link']);
  });

  it('does nothing to a case that already reached an outcome', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);
    await workflow.stop('case-1');

    const driven = await workflow.drive('case-1');

    expect(driven.status).toBe('stopped');
    expect(provider.calls).toHaveLength(0);
  });
});
