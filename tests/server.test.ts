import { describe, expect, it } from 'vitest';
import { createRecoveryServer, publishSeededBatchIfMissing } from '../src/server.js';
import { createRecoveryApplication } from '../src/application.js';
import { InMemoryRecoveryStore } from '../src/recovery.js';
import { FixedClock } from '../src/provider.js';
import { loadConfig } from '../src/config.js';

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
    return createRecoveryApplication({ config: { port: 0 }, clock: new FixedClock('2026-01-01T00:00:00.000Z'), store: new InMemoryRecoveryStore() });
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
});
