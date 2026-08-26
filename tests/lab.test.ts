import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRecoveryApplication } from '../src/application.js';
import { createRequestListener } from '../src/http.js';
import { RazorpayTestModeProvider, FixedClock } from '../src/provider.js';
import { InMemoryRecoveryStore } from '../src/recovery.js';
import { labScenarios, type LabScenario } from '../src/lab.js';

const config = { port: 0 };
const NOW = '2026-01-01T00:00:00.000Z';

async function boot(provider?: ConstructorParameters<typeof RazorpayTestModeProvider>[0]): Promise<{ server: Server; origin: string }> {
  const application = createRecoveryApplication({
    config, clock: new FixedClock(NOW), store: new InMemoryRecoveryStore(),
    ...(provider === undefined ? {} : { provider: new RazorpayTestModeProvider(provider) }),
  });
  const server = createServer(createRequestListener(application));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

let server: Server;
let origin: string;

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

/** Signs a body through the lab, then delivers it to the real webhook boundary. */
async function deliver(body: unknown, tamper = false): Promise<Response> {
  const raw = JSON.stringify(body);
  const signed = await fetch(`${origin}/api/lab/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  const { signature } = await signed.json() as { signature: string };
  // Tampering alters the delivered bytes only, leaving the signature bound to the original body.
  const delivered = tamper ? `${raw.slice(0, -1)},"injected":true}` : raw;
  return fetch(`${origin}/webhooks/razorpay`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature }, body: delivered,
  });
}

describe('webhook replay lab', () => {
  beforeEach(async () => { ({ server, origin } = await boot()); });

  it('offers scenarios that are independent across runs', async () => {
    const first = await (await fetch(`${origin}/api/lab/scenarios?run=a`)).json() as LabScenario[];
    const second = await (await fetch(`${origin}/api/lab/scenarios?run=b`)).json() as LabScenario[];
    expect(first.map((scenario) => scenario.key)).toEqual(['open', 'duplicate', 'ordering', 'forged']);
    // Replaying the lab must not collide with an earlier run's cases.
    expect(first.map((scenario) => scenario.caseId)).not.toEqual(second.map((scenario) => scenario.caseId));
  });

  it('signs a body the boundary then accepts', async () => {
    const [open] = labScenarios('run-1', NOW);
    const response = await deliver(open!.steps[0]!.payload);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, duplicate: false, caseId: open!.caseId });
  });

  it('recognises a redelivered event rather than acting twice', async () => {
    const duplicate = labScenarios('run-1', NOW).find((scenario) => scenario.key === 'duplicate')!;
    const first = await deliver(duplicate.steps[0]!.payload);
    const second = await deliver(duplicate.steps[1]!.payload);
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    const detail = await (await fetch(`${origin}/api/cases/${encodeURIComponent(duplicate.caseId)}`)).json() as { actions: unknown[] };
    // One event, one case, and no second round of recovery actions from the redelivery.
    expect(detail.actions.length).toBeLessThanOrEqual(1);
  });

  it('keeps a recovered case recovered when a stale failure arrives late', async () => {
    const ordering = labScenarios('run-1', NOW).find((scenario) => scenario.key === 'ordering')!;
    for (const step of ordering.steps) expect((await deliver(step.payload)).status).toBe(step.expectStatus);
    const detail = await (await fetch(`${origin}/api/cases/${encodeURIComponent(ordering.caseId)}`)).json() as { status: string };
    expect(detail.status).toBe('recovered');
  });

  it('rejects a body altered after it was signed, before anything downstream sees it', async () => {
    const forged = labScenarios('run-1', NOW).find((scenario) => scenario.key === 'forged')!;
    const response = await deliver(forged.steps[0]!.payload, true);
    expect(response.status).toBe(401);
    // Verification precedes parsing and storage, so the forged delivery opened no case at all.
    expect((await fetch(`${origin}/api/cases/${encodeURIComponent(forged.caseId)}`)).status).toBe(404);
  });

  it('every scenario step declares the status the boundary actually answers with', async () => {
    for (const scenario of labScenarios('run-1', NOW)) {
      for (const step of scenario.steps) {
        expect((await deliver(step.payload, step.tamper ?? false)).status).toBe(step.expectStatus);
      }
    }
  });
});

describe('replay lab with real Razorpay credentials', () => {
  beforeEach(async () => { ({ server, origin } = await boot({ keyId: 'rzp_test_lab', keySecret: 'secret', clock: new FixedClock(NOW) })); });

  it('serves no signing endpoint, so the instance cannot be used to forge a delivery', async () => {
    expect((await fetch(`${origin}/api/lab/scenarios`)).status).toBe(404);
    const signed = await fetch(`${origin}/api/lab/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(signed.status).toBe(404);
  });
});
