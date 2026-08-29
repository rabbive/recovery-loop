import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExpirySweeper, startExpiryScheduler, type ExpirySweepResult } from '../src/expiry.js';
import { DeterministicSimulator, FixedClock } from '../src/provider.js';
import { DeterministicPolicy, FixtureDiagnosisEngine, InMemoryRecoveryStore, RecoveryWorkflow, type ExpiryResult, type RecoveryStore } from '../src/recovery.js';
import { addAction, appendAudit, createRecoveryCase, updateAction, withStatus, type RecoveryCase } from '../src/domain.js';

const START = '2026-01-01T00:00:00.000Z';
const AFTER_EXPIRY = '2026-01-03T00:00:00.000Z';
const context = { customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: START };

/** A case resting on a fallback link that lapsed a day ago and nobody paid. */
function lapsedCase(id: string): RecoveryCase {
  const opened = createRecoveryCase(id, context, START);
  const offered = addAction(opened, { id: `${id}:action:fallback_link:1`, kind: 'fallback_link', status: 'submitted', idempotencyKey: `${id}:fallback_link`, providerReference: `sim_link_${id}`, expiresAt: '2026-01-02T00:00:00.000Z', createdAt: START }, START);
  return withStatus(withStatus(offered, 'diagnosed', START), 'fallback_link_available', START);
}

/**
 * The real workflow's expiry, minus everything the sweeper does not exercise. Using the workflow
 * would drag diagnosis and policy into a test about how much one tick is allowed to do.
 */
function workflowDouble(store: InMemoryRecoveryStore): RecoveryWorkflow {
  return {
    async expireLapsedFallbackLinkWithOutcome(caseId: string): Promise<ExpiryResult> {
      return store.withCaseLock(caseId, async (transaction) => {
        const current = await transaction.get();
        if (!current) throw new Error(`Recovery Case not found: ${caseId}`);
        const lapsed = current.actions.find((action) => action.kind === 'fallback_link' && action.status !== 'failed');
        if (!lapsed) return { recoveryCase: current, expired: false };
        const failed = updateAction(current, lapsed.idempotencyKey, { status: 'failed' }, AFTER_EXPIRY);
        const exhausted = withStatus(appendAudit(failed, { type: 'fallback_link_expired', actor: 'system', at: AFTER_EXPIRY, explanation: 'expired', data: {} }), 'exhausted', AFTER_EXPIRY, 'exhausted');
        await transaction.save(exhausted);
        return { recoveryCase: exhausted, expired: true };
      });
    },
  } as unknown as RecoveryWorkflow;
}

async function sweeperOver(caseCount: number): Promise<{ sweeper: ExpirySweeper; store: InMemoryRecoveryStore }> {
  const store = new InMemoryRecoveryStore();
  for (let index = 0; index < caseCount; index += 1) await store.save(lapsedCase(`case-${String(index).padStart(3, '0')}`));
  return { sweeper: new ExpirySweeper(store, workflowDouble(store), new FixedClock(AFTER_EXPIRY)), store };
}

describe('bounded expiry sweep', () => {
  it('takes at most a hundred cases a tick and says a backlog remains', async () => {
    const { sweeper, store } = await sweeperOver(105);

    const first = await sweeper.sweep();

    expect(first.inspected).toBe(100);
    expect(first.expiredCaseIds).toHaveLength(100);
    expect(first.moreDue).toBe(true);
    expect((await store.all()).filter((recoveryCase) => recoveryCase.status !== 'exhausted')).toHaveLength(5);
  });

  it('drains the remainder on the next tick and reports the backlog cleared', async () => {
    const { sweeper, store } = await sweeperOver(105);
    await sweeper.sweep();

    const second = await sweeper.sweep();

    expect(second.inspected).toBe(5);
    expect(second.expiredCaseIds).toHaveLength(5);
    expect(second.moreDue).toBe(false);
    expect((await store.all()).every((recoveryCase) => recoveryCase.status === 'exhausted')).toBe(true);
  });

  it('refuses a limit that would let one tick walk the whole table', async () => {
    const { sweeper } = await sweeperOver(1);

    await expect(sweeper.sweep(0)).rejects.toThrow(/between 1 and 100/);
    await expect(sweeper.sweep(1000)).rejects.toThrow(/between 1 and 100/);
  });

  it('reports only the cases this sweep actually expired', async () => {
    // A case that settled between the query and the lock is not one the sweep may claim.
    const store = new InMemoryRecoveryStore();
    await store.save(lapsedCase('case-1'));
    const finder: RecoveryStore = { ...store, findLapsedFallbackCaseIds: async () => ['case-1'], get: (id) => store.get(id), all: () => store.all(), save: (value) => store.save(value), withCaseLock: (id, operation) => store.withCaseLock(id, operation), healthCheck: () => store.healthCheck() };
    const settled = {
      async expireLapsedFallbackLinkWithOutcome(): Promise<ExpiryResult> {
        // Another transaction exhausted this case after the due-list query but before this lock.
        return { recoveryCase: { ...lapsedCase('case-1'), status: 'exhausted' }, expired: false };
      },
    } as unknown as RecoveryWorkflow;

    const result = await new ExpirySweeper(finder, settled, new FixedClock(AFTER_EXPIRY)).sweep();

    expect(result.inspected).toBe(1);
    expect(result.expiredCaseIds).toEqual([]);
  });

  it('omits a stale due id that the real workflow finds terminal under the case lock', async () => {
    const clock = new FixedClock(AFTER_EXPIRY);
    const store = new InMemoryRecoveryStore();
    await store.save(lapsedCase('case-1'));
    const finder: RecoveryStore = {
      get: (id) => store.get(id),
      all: () => store.all(),
      save: (value) => store.save(value),
      withCaseLock: (id, operation) => store.withCaseLock(id, operation),
      healthCheck: () => store.healthCheck(),
      findLapsedFallbackCaseIds: async (now, limit) => {
        const staleDueIds = await store.findLapsedFallbackCaseIds(now, limit);
        const current = await store.get('case-1');
        if (current) await store.save(withStatus(current, 'stopped', AFTER_EXPIRY, 'stopped'));
        return staleDueIds;
      },
    };
    const workflow = new RecoveryWorkflow(
      finder,
      new DeterministicSimulator(new Map(), clock),
      new FixtureDiagnosisEngine(),
      new DeterministicPolicy(),
      clock,
    );

    const result = await new ExpirySweeper(finder, workflow, clock).sweep();

    expect(result.inspected).toBe(1);
    expect(result.expiredCaseIds).toEqual([]);
  });
});

describe('expiry schedule', () => {
  afterEach(() => { vi.useRealTimers(); });

  function sweeperSpy(behaviour: () => Promise<ExpirySweepResult> = async () => ({ inspected: 0, expiredCaseIds: [], moreDue: false })) {
    const sweep = vi.fn(behaviour);
    return { sweep, sweeper: { sweep } as unknown as ExpirySweeper };
  }

  it('sweeps once at start and again every interval', async () => {
    vi.useFakeTimers();
    const { sweep, sweeper } = sweeperSpy();

    const scheduler = startExpiryScheduler(sweeper, { intervalMilliseconds: 60_000 });
    expect(sweep).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('skips a tick rather than running two sweeps over the same due list', async () => {
    vi.useFakeTimers();
    let release: (result: ExpirySweepResult) => void = () => undefined;
    const { sweep, sweeper } = sweeperSpy(() => new Promise<ExpirySweepResult>((resolve) => { release = resolve; }));
    const scheduler = startExpiryScheduler(sweeper, { intervalMilliseconds: 60_000 });

    await vi.advanceTimersByTimeAsync(180_000);

    expect(sweep).toHaveBeenCalledTimes(1);
    release({ inspected: 0, expiredCaseIds: [], moreDue: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweep).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('reports a failed sweep and keeps sweeping', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { sweep, sweeper } = sweeperSpy();
    sweep.mockRejectedValueOnce(new Error('store is down'));
    const scheduler = startExpiryScheduler(sweeper, { intervalMilliseconds: 60_000, onError });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'store is down' }));
    expect(sweep).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('stops sweeping once the server has closed', async () => {
    vi.useFakeTimers();
    const { sweep, sweeper } = sweeperSpy();
    const scheduler = startExpiryScheduler(sweeper, { intervalMilliseconds: 60_000 });

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(300_000);

    expect(sweep).toHaveBeenCalledTimes(1);
  });
});
