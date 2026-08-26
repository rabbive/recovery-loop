import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createRecoveryApplication, type RecoveryApplication } from './application.js';
import { loadConfig, type RuntimeConfig } from './config.js';
import { createRequestListener } from './http.js';

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

export async function bootstrap(recoveryServer: RecoveryServer = createRecoveryServer()): Promise<void> {
  const { application, server } = recoveryServer;
  if (application.postgresStore) await application.postgresStore.initialize();
  server.listen(application.config.port, () => console.log(`Recovery Loop listening on http://localhost:${application.config.port}`));
}

// Importing this module composes nothing; only running it starts a server.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void bootstrap().catch((error: unknown) => {
    console.error('Recovery Loop failed to start', error);
    process.exitCode = 1;
  });
}
