import { createServer } from 'node:http';
import { FixedClock } from './provider.js';
import { createRecoveryApplication } from './application.js';
import { loadConfig } from './config.js';
import { createRequestListener } from './http.js';

const config = loadConfig();
const application = createRecoveryApplication({ config, clock: new FixedClock('2026-01-01T00:00:00.000Z') });
const server = createServer(createRequestListener(application));

async function bootstrap(): Promise<void> {
  if (application.postgresStore) await application.postgresStore.initialize();
  server.listen(config.port, () => console.log(`Recovery Loop listening on http://localhost:${config.port}`));
}

void bootstrap().catch((error: unknown) => {
  console.error('Recovery Loop failed to start', error);
  process.exitCode = 1;
});
