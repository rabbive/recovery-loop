import { describe, expect, it } from 'vitest';
import { DeterministicSimulator, FixedClock, type SimulatorScenario } from '../src/provider.js';
import { DeterministicPolicy, FixtureDiagnosisEngine, InMemoryRecoveryStore, RecoveryWorkflow } from '../src/recovery.js';

const context = {
  customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z',
};

function setup(scenario: SimulatorScenario = { retry: 'success', fallback: 'success', diagnosis: 'transient' }) {
  const clock = new FixedClock('2026-01-01T00:00:00.000Z');
  const store = new InMemoryRecoveryStore();
  const provider = new DeterministicSimulator(new Map([['case-1', scenario]]), clock);
  const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(), new DeterministicPolicy(), clock);
  return { workflow, provider, store };
}

function event(
  id: string,
  type: 'payment_failed' | 'payment_succeeded' | 'payment_pending' | 'subscription_cancelled' | 'dispute_opened' | 'unknown',
  occurredAt: string,
  payload: Record<string, unknown> = {},
  // A success must name the provider object that settled it, or nothing on the case can claim it.
  correlation: { readonly providerPaymentId?: string; readonly providerActionReference?: string } = {},
) {
  return { id, type, caseId: 'case-1', occurredAt, payload, ...correlation };
}

async function openFailedCase(workflow: RecoveryWorkflow, provider: DeterministicSimulator) {
  await workflow.openCase('case-1', context);
  await workflow.ingestEvent(provider.normalizeEvent(event('event-1', 'payment_failed', '2026-01-01T00:00:00.000Z', { method: 'recurring_mandate' }), '2026-01-01T00:00:01.000Z'));
}

describe('event ordering', () => {
  it('attributes a success that lands after the retry was already recorded as failed', async () => {
    // The provider accepted the retry, later reported it failed, and the money arrived after all.
    const { workflow, provider, store } = setup();
    await openFailedCase(workflow, provider);
    await workflow.runDiagnosis('case-1');
    await workflow.authorize('case-1');
    await workflow.executePending('case-1');
    // The Razorpay adapter answers `submitted`, so the real outcome only arrives as a webhook.
    const submitted = await store.get('case-1');
    await store.save({ ...submitted!, actions: submitted!.actions.map((action) => ({ ...action, status: 'submitted' as const })) });
    await workflow.ingestEvent(provider.normalizeEvent(event('event-2', 'payment_failed', '2026-01-01T00:01:00.000Z', { method: 'recurring_mandate' }), '2026-01-01T00:01:01.000Z'));

    const recovered = await workflow.ingestEvent(provider.normalizeEvent(event('event-3', 'payment_succeeded', '2026-01-01T00:05:00.000Z', {}, { providerPaymentId: 'sim_retry_case-1' }), '2026-01-01T00:05:01.000Z'));

    expect(recovered.status).toBe('recovered');
    expect(recovered.recoveredAmount).toBe(1200);
    expect(recovered.recoveryAttribution?.actionKind).toBe('retry');
  });

  it('never offers a fallback link to a customer who already paid', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);
    await workflow.runDiagnosis('case-1');
    await workflow.authorize('case-1');
    await workflow.executePending('case-1');
    await workflow.ingestEvent(provider.normalizeEvent(event('event-2', 'payment_succeeded', '2026-01-01T00:05:00.000Z', {}, { providerPaymentId: 'sim_retry_case-1' }), '2026-01-01T00:05:01.000Z'));

    const afterSuccess = await workflow.authorize('case-1');
    await workflow.executePending('case-1');

    expect(afterSuccess.status).toBe('recovered');
    expect(afterSuccess.actions.filter((action) => action.kind === 'fallback_link')).toHaveLength(0);
    expect(provider.calls.map((call) => call.kind)).toEqual(['retry']);
  });

  it('audits a success that no recovery action can explain instead of dropping it', async () => {
    // Nothing was authorized yet, so this payment is not recovered revenue — but it is evidence.
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);

    const result = await workflow.ingestEvent(provider.normalizeEvent(event('event-2', 'payment_succeeded', '2026-01-01T00:00:02.000Z'), '2026-01-01T00:00:03.000Z'));

    expect(result.recoveredAmount).toBe(0);
    expect(result.audit.map((entry) => entry.type)).toContain('pre_existing_success');
  });

  it('ignores a failure that arrives after the renewal was already recovered, and says so', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);
    await workflow.runDiagnosis('case-1');
    await workflow.authorize('case-1');
    await workflow.executePending('case-1');
    await workflow.ingestEvent(provider.normalizeEvent(event('event-2', 'payment_succeeded', '2026-01-01T00:00:04.000Z', {}, { providerPaymentId: 'sim_retry_case-1' }), '2026-01-01T00:00:05.000Z'));

    const late = await workflow.ingestEvent(provider.normalizeEvent(event('event-3', 'payment_failed', '2026-01-01T00:00:03.000Z', { method: 'recurring_mandate' }), '2026-01-01T00:00:06.000Z'));

    expect(late.status).toBe('recovered');
    expect(late.recoveredAmount).toBe(1200);
    expect(late.audit.map((entry) => entry.type)).toContain('late_event_ignored');
  });

  it('reaches the same final state whether success or cancellation is delivered first', async () => {
    const succeededFirst = setup();
    await openFailedCase(succeededFirst.workflow, succeededFirst.provider);
    await succeededFirst.workflow.runDiagnosis('case-1');
    await succeededFirst.workflow.authorize('case-1');
    await succeededFirst.workflow.executePending('case-1');
    await succeededFirst.workflow.ingestEvent(succeededFirst.provider.normalizeEvent(event('event-2', 'payment_succeeded', '2026-01-01T00:00:04.000Z', {}, { providerPaymentId: 'sim_retry_case-1' }), '2026-01-01T00:00:05.000Z'));
    const afterCancellation = await succeededFirst.workflow.ingestEvent(succeededFirst.provider.normalizeEvent(event('event-3', 'subscription_cancelled', '2026-01-01T00:00:06.000Z'), '2026-01-01T00:00:07.000Z'));

    expect(afterCancellation.status).toBe('recovered');
    expect(afterCancellation.audit.map((entry) => entry.type)).toContain('late_event_ignored');
  });

  it('records a duplicate delivery once and leaves the case untouched', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);
    const duplicate = provider.normalizeEvent(event('event-1', 'payment_failed', '2026-01-01T00:00:00.000Z', { method: 'recurring_mandate' }), '2026-01-01T00:00:09.000Z');

    const result = await workflow.ingestEvent(duplicate);

    expect(result.events).toHaveLength(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.audit.filter((entry) => entry.type === 'provider_event_received')).toHaveLength(1);
  });

  it('records an unsupported event type without acting on it', async () => {
    const { workflow, provider } = setup();
    await openFailedCase(workflow, provider);

    const result = await workflow.ingestEvent(provider.normalizeEvent(event('event-2', 'unknown', '2026-01-01T00:00:02.000Z'), '2026-01-01T00:00:03.000Z'));

    expect(result.status).toBe('at_risk');
    expect(result.actions).toHaveLength(0);
    expect(result.audit.map((entry) => entry.type)).toContain('provider_event_received');
  });
});
