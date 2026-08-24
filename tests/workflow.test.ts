import { describe, expect, it } from 'vitest';
import type { Diagnosis } from '../src/domain.js';
import { DeterministicSimulator, FixedClock, type SimulatorScenario } from '../src/provider.js';
import { DeterministicPolicy, FixtureDiagnosisEngine, InMemoryRecoveryStore, RecoveryWorkflow } from '../src/recovery.js';

const context = {
  customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z',
};

function setup(diagnosis?: Diagnosis, scenario: SimulatorScenario = { retry: 'success', fallback: 'success', diagnosis: 'transient' }) {
  const store = new InMemoryRecoveryStore();
  const provider = new DeterministicSimulator(new Map([['case-1', scenario]]));
  const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(new Map(diagnosis ? [['case-1', diagnosis]] : [])), new DeterministicPolicy(), new FixedClock('2026-01-01T00:00:00.000Z'));
  return { workflow, provider };
}

function failed(workflow: RecoveryWorkflow, provider: DeterministicSimulator) {
  workflow.openCase('case-1', context);
  workflow.ingestEvent(provider.normalizeEvent({ id: 'event-1', type: 'payment_failed', caseId: 'case-1', occurredAt: '2026-01-01T00:00:00.000Z', payload: { method: 'recurring_mandate', failureCode: 'temporary' } }, '2026-01-01T00:00:01.000Z'));
}

describe('RecoveryWorkflow', () => {
  it('authorizes and executes one retry, then attributes correlated success', () => {
    const { workflow, provider } = setup();
    failed(workflow, provider);
    workflow.runDiagnosis('case-1');
    expect(workflow.authorize('case-1').status).toBe('retry_scheduled');
    expect(workflow.executePending('case-1').actions[0]?.status).toBe('succeeded');
    const result = workflow.ingestEvent(provider.normalizeEvent({ id: 'event-2', type: 'payment_succeeded', caseId: 'case-1', occurredAt: '2026-01-01T00:00:02.000Z' }, '2026-01-01T00:00:03.000Z'));
    expect(result.status).toBe('recovered');
    expect(result.recoveredAmount).toBe(1200);
  });

  it('offers exactly one fallback link after a failed retry', () => {
    const { workflow, provider } = setup(undefined, { retry: 'failure', fallback: 'success', diagnosis: 'transient' });
    failed(workflow, provider);
    workflow.runDiagnosis('case-1');
    workflow.authorize('case-1');
    workflow.executePending('case-1');
    expect(workflow.authorize('case-1').status).toBe('fallback_link_available');
    workflow.executePending('case-1');
    const result = workflow.ingestEvent(provider.normalizeEvent({ id: 'event-3', type: 'payment_succeeded', caseId: 'case-1', occurredAt: '2026-01-01T00:00:04.000Z' }, '2026-01-01T00:00:05.000Z'));
    expect(result.actions.filter((action) => action.kind === 'fallback_link')).toHaveLength(1);
    expect(result.status).toBe('recovered');
    expect(provider.calls).toHaveLength(2);
  });

  it('fails safe for low confidence and hard declines', () => {
    const lowConfidence = { failureCategory: 'transient' as const, confidence: 0.2, evidence: ['signal'], recommendedAction: 'retry' as const, explanation: 'uncertain', modelVersion: 'test' };
    const low = setup(lowConfidence);
    failed(low.workflow, low.provider);
    low.workflow.runDiagnosis('case-1');
    expect(low.workflow.authorize('case-1').status).toBe('escalated');
    expect(low.provider.calls).toHaveLength(0);

    const hard = setup({ failureCategory: 'hard_decline', confidence: 0.99, evidence: ['decline'], recommendedAction: 'retry', explanation: 'hard decline', modelVersion: 'test' });
    failed(hard.workflow, hard.provider);
    hard.workflow.runDiagnosis('case-1');
    expect(hard.workflow.authorize('case-1').outcome).toBe('escalated');
  });

  it('deduplicates events and blocks actions after terminal success', () => {
    const { workflow, provider } = setup();
    failed(workflow, provider);
    workflow.ingestEvent(provider.normalizeEvent({ id: 'event-1', type: 'payment_failed', caseId: 'case-1', occurredAt: '2026-01-01T00:00:00.000Z' }, '2026-01-01T00:00:01.000Z'));
    workflow.runDiagnosis('case-1');
    workflow.authorize('case-1');
    workflow.executePending('case-1');
    workflow.ingestEvent(provider.normalizeEvent({ id: 'event-2', type: 'payment_succeeded', caseId: 'case-1', occurredAt: '2026-01-01T00:00:02.000Z' }, '2026-01-01T00:00:03.000Z'));
    expect(workflow.ingestEvent(provider.normalizeEvent({ id: 'event-2', type: 'payment_succeeded', caseId: 'case-1', occurredAt: '2026-01-01T00:00:02.000Z' }, '2026-01-01T00:00:04.000Z')).status).toBe('recovered');
    expect(provider.calls).toHaveLength(1);
  });
});
