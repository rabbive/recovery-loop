import type { Clock } from './provider.js';
import type { RecoveryStore, RecoveryWorkflow } from './recovery.js';

export interface ExpirySweepResult {
  readonly inspected: number;
  readonly expiredCaseIds: readonly string[];
  /** Whether more cases were already due than this sweep was allowed to take. */
  readonly moreDue: boolean;
}

/** No single tick may walk an unbounded table, however far behind the sweeper has fallen. */
const MAXIMUM_SWEEP = 100;

/**
 * Retires fallback links the customer never paid.
 *
 * Nothing else closes the loop for a case resting in `fallback_link_available`: the link lapses,
 * the customer never returns, and the renewal counts as revenue at risk forever. Expiry used to
 * happen only when somebody called `POST /api/expire` by hand, which on a deployed instance means
 * never.
 *
 * The sweep asks the store which cases are due rather than reading every case, and takes at most a
 * hundred of them. A backlog is drained across ticks instead of in one query that grows with the
 * table.
 */
export class ExpirySweeper {
  constructor(
    private readonly store: RecoveryStore,
    private readonly workflow: RecoveryWorkflow,
    private readonly clock: Clock,
  ) {}

  async sweep(limit: number = MAXIMUM_SWEEP): Promise<ExpirySweepResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAXIMUM_SWEEP) throw new Error(`Expiry sweep limit must be an integer between 1 and ${MAXIMUM_SWEEP}: ${limit}`);
    const now = this.clock.now().toISOString();
    // One more than the limit, so "there is still a backlog" is an observation rather than a guess.
    const due = await this.store.findLapsedFallbackCaseIds(now, limit + 1);
    const inspecting = due.slice(0, limit);
    const expiredCaseIds: string[] = [];
    for (const caseId of inspecting) {
      // The workflow takes the case lock and rechecks: a case that was paid or settled between the
      // query and here is no longer due, and must not be reported as one this sweep exhausted.
      const swept = await this.workflow.expireLapsedFallbackLink(caseId);
      if (swept.status === 'exhausted') expiredCaseIds.push(caseId);
    }
    return { inspected: inspecting.length, expiredCaseIds, moreDue: due.length > limit };
  }
}

export interface ExpirySchedulerOptions {
  readonly intervalMilliseconds?: number;
  readonly onError?: (error: unknown) => void;
}

/** How often the sweeper runs. Link TTLs are measured in hours, so a minute is ample. */
const DEFAULT_INTERVAL_MILLISECONDS = 60_000;

/**
 * Runs the sweep on a schedule for as long as the server is listening.
 *
 * A tick that arrives while the previous sweep is still working is skipped rather than queued: two
 * overlapping sweeps would read the same due list and contend for the same case locks, turning a
 * slow database into a growing pile of blocked work. A failing sweep is reported and the schedule
 * continues, because a database blip must not silently retire the only thing that closes the loop.
 */
export function startExpiryScheduler(sweeper: ExpirySweeper, options: ExpirySchedulerOptions = {}): { stop(): void } {
  const interval = options.intervalMilliseconds ?? DEFAULT_INTERVAL_MILLISECONDS;
  const onError = options.onError ?? ((error: unknown) => console.error('Recovery Loop expiry sweep failed', error));
  let running = false;
  let stopped = false;
  const tick = (): void => {
    if (running || stopped) return;
    running = true;
    void sweeper.sweep().then(() => undefined, onError).finally(() => { running = false; });
  };
  tick();
  const timer = setInterval(tick, interval);
  // The schedule must never be the reason a process refuses to exit.
  timer.unref?.();
  return {
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
