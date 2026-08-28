import { describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRecoveryApplication } from '../src/application.js';
import { createRequestListener } from '../src/http.js';
import { FixedClock } from '../src/provider.js';
import { InMemoryRecoveryStore } from '../src/recovery.js';
import { InMemoryEvaluationRunStore, generateEvaluationCases, runEvaluation, toEvaluationRun, type EvaluationRun } from '../src/evaluation.js';

const CONTROL_TOKEN = 'evaluation-store-token';
const config = { port: 0, logLevel: 'info' as const, controlPlaneToken: CONTROL_TOKEN, razorpayRecurringRetryEnabled: false };

async function run(seed: number): Promise<EvaluationRun> {
  return toEvaluationRun(await runEvaluation(generateEvaluationCases(50, seed)), '2026-01-01T00:00:00.000Z');
}

describe('evaluation run store', () => {
  it('reports no run before a batch has been published', async () => {
    expect(await new InMemoryEvaluationRunStore().latestRun()).toBeUndefined();
  });

  it('replays the most recently published run', async () => {
    const store = new InMemoryEvaluationRunStore();
    await store.saveRun(await run(42));
    await store.saveRun(await run(7));

    const latest = await store.latestRun();

    expect(latest?.metrics.seed).toBe(7);
    expect(latest?.results).toHaveLength(50);
  });
});

/** Restarting the process must not change the figures a merchant has already been shown. */
describe('published figures across a restart', () => {
  it('serves the persisted run and its metrics to a listener that never ran the batch', async () => {
    const evaluationRuns = new InMemoryEvaluationRunStore();
    const store = new InMemoryRecoveryStore();
    const first = await listen(store, evaluationRuns);
    const published = await fetch(`${first.origin}/api/evaluation`, { method: 'POST', headers: { authorization: `Bearer ${CONTROL_TOKEN}` } }).then((response) => response.json()) as { metrics: { recoveredAmount: number } };
    const publishedMetrics = await fetch(`${first.origin}/api/metrics`).then((response) => response.json());
    await first.close();

    const restarted = await listen(store, evaluationRuns);
    const replayed = await fetch(`${restarted.origin}/api/evaluation`).then((response) => response.json()) as { available: boolean; metrics: { recoveredAmount: number } };
    const metrics = await fetch(`${restarted.origin}/api/metrics`).then((response) => response.json());
    await restarted.close();

    expect(replayed.available).toBe(true);
    expect(replayed.metrics).toEqual(published.metrics);
    expect(metrics).toEqual(publishedMetrics);
  });
});

async function listen(store: InMemoryRecoveryStore, evaluationRuns: InMemoryEvaluationRunStore) {
  const application = createRecoveryApplication({ config, clock: new FixedClock('2026-01-01T00:00:00.000Z'), store, evaluationRuns });
  const server: Server = createServer(createRequestListener(application));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
