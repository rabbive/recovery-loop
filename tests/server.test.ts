import { createServer, type Server } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { bootstrap, createRecoveryServer, publishSeededBatchIfMissing } from '../src/server.js';
import { createRecoveryApplication } from '../src/application.js';
import { createRequestListener } from '../src/http.js';
import { InMemoryRecoveryStore } from '../src/recovery.js';
import { FixedClock } from '../src/provider.js';
import { loadConfig } from '../src/config.js';

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe('server composition', () => {
  it('runs on a clock that moves, so fallback links can lapse and audit timestamps differ', () => {
    // A pinned clock here would freeze the whole deployment: `expireLapsedFallbackLink` could
    // never fire and every audit event would carry one instant. Time is pinned in tests and in
    // the seeded batch, never in the running app.
    const before = Date.now();

    const { application } = createRecoveryServer(loadConfig({ PORT: '3100' }));

    const now = application.clock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('composes the listener without binding a port', () => {
    const { server } = createRecoveryServer(loadConfig({ PORT: '3100' }));

    expect(server.listening).toBe(false);
  });
});

describe('publishing the seeded batch on start', () => {
  function application() {
    return createRecoveryApplication({ config: { port: 0, razorpayRecurringRetryEnabled: false, requireDatabase: false }, clock: new FixedClock('2026-01-01T00:00:00.000Z'), store: new InMemoryRecoveryStore() });
  }

  it('publishes figures so a cold instance does not greet its visitor with zeroes', async () => {
    const app = application();
    expect(await app.evaluationRuns.latestRun()).toBeUndefined();

    await publishSeededBatchIfMissing(app);

    const run = await app.evaluationRuns.latestRun();
    expect(run?.metrics.totalCases).toBe(60);
    // The cases the batch drove are what the dashboard lists, so they must be stored too.
    expect((await app.store.all()).length).toBe(60);
  });

  it('leaves an already-published run alone, so a restart cannot restate the figures', async () => {
    const app = application();
    await publishSeededBatchIfMissing(app);
    const first = await app.evaluationRuns.latestRun();

    await publishSeededBatchIfMissing(app);

    expect(await app.evaluationRuns.latestRun()).toEqual(first);
  });

  it('still serves when the batch cannot be published', async () => {
    const app = application();
    const failing = { ...app, evaluationRuns: { saveRun: async () => { throw new Error('store is down'); }, latestRun: async () => undefined } };

    // A dashboard without figures is bad; an instance that refuses to start is worse.
    await expect(publishSeededBatchIfMissing(failing)).resolves.toBeUndefined();
  });

  it('never starts listening when a required database cannot be initialized', async () => {
    // A deployment that answers 200 while quietly holding its cases in memory is worse than one
    // that refuses to boot: the figures look real right up until the dyno restarts.
    const application = createRecoveryApplication({ config: { port: 0, razorpayRecurringRetryEnabled: false, requireDatabase: true, databaseUrl: 'postgres://unreachable/recovery_loop' }, clock: new FixedClock('2026-01-01T00:00:00.000Z'), store: new InMemoryRecoveryStore() });
    const server = createServer(() => undefined);
    const listen = vi.spyOn(server, 'listen');
    const failing = { ...application, postgresStore: { initialize: async () => { throw new Error('database is unreachable'); } } } as unknown as typeof application;

    await expect(bootstrap({ application: failing, server })).rejects.toThrow(/unreachable/);

    expect(listen).not.toHaveBeenCalled();
  });
});

describe('bootstrapping into production', () => {
  it('initializes the composed postgres store before publishing the batch and listening', async () => {
    const application = createRecoveryApplication({ config: { port: 0, razorpayRecurringRetryEnabled: false, requireDatabase: false }, clock: new FixedClock('2026-01-01T00:00:00.000Z'), store: new InMemoryRecoveryStore() });
    const initialize = vi.fn().mockResolvedValue(undefined);
    const withStore = { ...application, postgresStore: { initialize } } as unknown as typeof application;
    const server = createServer(createRequestListener(application));

    await bootstrap({ application: withStore, server });

    expect(initialize).toHaveBeenCalledTimes(1);
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    expect(server.listening).toBe(true);
    // A cold instance booted through the real entrypoint greets with figures, not zeroes.
    expect(await application.evaluationRuns.latestRun()).toBeDefined();
    await closeServer(server);
  });

  it('leaves the expiry sweep running for the life of the server and stops it on close', async () => {
    vi.useFakeTimers();
    try {
      const application = createRecoveryApplication({ config: { port: 0, razorpayRecurringRetryEnabled: false, requireDatabase: false }, clock: new FixedClock('2026-01-01T00:00:00.000Z'), store: new InMemoryRecoveryStore() });
      const sweep = vi.spyOn(application.expirySweeper, 'sweep');
      const server = createServer(createRequestListener(application));

      await bootstrap({ application, server });
      if (!server.listening) await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      expect(sweep).toHaveBeenCalledTimes(1); // the startup tick

      await vi.advanceTimersByTimeAsync(120_000);
      const callsWhileServing = sweep.mock.calls.length;
      expect(callsWhileServing).toBeGreaterThan(1);

      await closeServer(server);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(sweep.mock.calls.length).toBe(callsWhileServing);
    } finally {
      vi.useRealTimers();
    }
  });
});
