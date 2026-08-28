import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRecoveryApplication, type RecoveryApplication } from './application.js';
import { loadConfig, type RuntimeConfig } from './config.js';
import { createRequestListener } from './http.js';
import { publishSeededBatch } from './evaluation.js';
import { startExpiryScheduler } from './expiry.js';

export interface RecoveryServer {
  readonly application: RecoveryApplication;
  readonly server: Server;
}

/**
 * Composes the deployable application and its listener without binding a port, so the wiring a
 * deployment runs is the wiring tests can inspect. The clock is left to the application: the
 * running app must keep real time, or no fallback link ever lapses and every audit event shares
 * one timestamp. Time is pinned in tests and in the seeded batch, never here.
 */
export function createRecoveryServer(config: RuntimeConfig = loadConfig()): RecoveryServer {
  const application = createRecoveryApplication({ config });
  return { application, server: createServer(createRequestListener(application)) };
}

/**
 * Publishes the seeded batch when the instance has none, so a cold start shows figures rather than
 * an empty dashboard nobody knows to populate. A host that sleeps an idle instance — or any plain
 * restart — would otherwise greet its next visitor with zeroes.
 *
 * Deterministic, so this cannot change what a returning visitor sees, and skipped entirely when a
 * run is already stored. A failure here is logged and swallowed: a dashboard without figures is bad,
 * but an instance that refuses to serve at all is worse.
 */
export async function publishSeededBatchIfMissing(application: RecoveryApplication): Promise<void> {
  try {
    if (await application.evaluationRuns.latestRun()) return;
    const run = await publishSeededBatch(application.store, application.evaluationRuns, application.clock.now().toISOString());
    console.log(`Recovery Loop published the seeded batch: ${run.metrics.totalCases} cases`);
  } catch (error) {
    console.error('Recovery Loop could not publish the seeded batch on start', error);
  }
}

export async function bootstrap(recoveryServer: RecoveryServer = createRecoveryServer()): Promise<void> {
  const { application, server } = recoveryServer;
  if (application.postgresStore) await application.postgresStore.initialize();
  await publishSeededBatchIfMissing(application);
  // Lapsed fallback links are retired for as long as this instance is serving, and no longer.
  const scheduler = startExpiryScheduler(application.expirySweeper);
  server.once('close', () => scheduler.stop());
  server.listen(application.config.port, () => console.log(`Recovery Loop listening on http://localhost:${application.config.port}`));
}

// Importing this module composes nothing; only running it starts a server.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void bootstrap().catch((error: unknown) => {
    console.error('Recovery Loop failed to start', error);
    process.exitCode = 1;
  });
}
