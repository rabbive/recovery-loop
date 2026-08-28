import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRecoveryApplication } from '../src/application.js';
import { createRequestListener } from '../src/http.js';
import { RazorpayTestModeProvider, FixedClock } from '../src/provider.js';
import { InMemoryRecoveryStore } from '../src/recovery.js';
import { labScenarios, type LabScenario, type LabReplayResult } from '../src/lab.js';

const config = { port: 0, controlPlaneToken: 'lab-control-token', simulatorWebhookSecret: 'lab-simulator-secret', razorpayRecurringRetryEnabled: false, requireDatabase: false };
const NOW = '2026-01-01T00:00:00.000Z';

async function boot(provider?: ConstructorParameters<typeof RazorpayTestModeProvider>[0]): Promise<{ server: Server; origin: string }> {
  const application = createRecoveryApplication({
    config, clock: new FixedClock(NOW), store: new InMemoryRecoveryStore(),
    ...(provider === undefined ? {} : { provider: new RazorpayTestModeProvider(provider) }),
  });
  const started = createServer(createRequestListener(application));
  await new Promise<void>((resolve) => started.listen(0, '127.0.0.1', resolve));
  return { server: started, origin: `http://127.0.0.1:${(started.address() as AddressInfo).port}` };
}

let server: Server;
let origin: string;

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

async function replay(scenario: unknown, extra: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${origin}/api/lab/replay`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario, ...extra }),
  });
}

async function replayed(key: string): Promise<LabReplayResult & { detail: { status: string } | null }> {
  const response = await replay(key);
  expect(response.status).toBe(200);
  return await response.json() as LabReplayResult & { detail: { status: string } | null };
}

describe('webhook replay lab', () => {
  beforeEach(async () => { ({ server, origin } = await boot()); });

  it('offers the four fixed scenarios and no way to choose their identities', async () => {
    const offered = await (await fetch(`${origin}/api/lab/scenarios`)).json() as LabScenario[];

    expect(offered.map((scenario) => scenario.key)).toEqual(['open', 'duplicate', 'ordering', 'forged']);
    // Each replay is isolated, so there is nothing for two runs to collide over and no run id to pick.
    expect(offered.every((scenario) => scenario.steps.length > 0)).toBe(true);
  });

  it('drives a registered case through the real boundary', async () => {
    const result = await replayed('open');

    expect(result.steps.map((step) => step.status)).toEqual([202]);
    expect(result.passed).toBe(result.total);
    expect(result.detail?.status).toBe('retry_scheduled');
  });

  it('recognises a redelivered event rather than acting twice', async () => {
    const result = await replayed('duplicate');

    expect(result.steps.map((step) => step.status)).toEqual([202, 200]);
    expect(result.steps[1]?.body).toMatchObject({ duplicate: true });
  });

  it('keeps a recovered case recovered when a stale failure arrives late', async () => {
    const result = await replayed('ordering');

    expect(result.passed).toBe(result.total);
    expect(result.detail?.status).toBe('recovered');
  });

  it('rejects a body altered after it was signed, before anything downstream sees it', async () => {
    const result = await replayed('forged');

    expect(result.steps.map((step) => step.status)).toEqual([401]);
    // Verification precedes parsing and lookup, so the forged delivery opened no case at all.
    expect(result.detail).toBeNull();
  });

  it('every scenario step declares the status the boundary actually answers with', async () => {
    for (const scenario of labScenarios()) {
      const result = await replayed(scenario.key);
      expect(result.steps.map((step) => step.status)).toEqual(scenario.steps.map((step) => step.expectStatus));
    }
  });

  /**
   * The old lab signed a body and handed the signature to the browser, which then delivered it to
   * the canonical webhook. That made every public visitor an authorized event source. Now a replay
   * happens entirely inside the process against a throwaway application: no signature leaves it,
   * and nothing a visitor presses can be aimed at the real store.
   */
  it('never hands a caller a signature or the bytes it signed', async () => {
    expect((await fetch(`${origin}/api/lab/sign`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);

    const body = await (await replay('open')).text();

    expect(body).not.toContain('signature');
    expect(body).not.toContain('rawBody');
    expect(body).not.toContain('lab-simulator-secret');
  });

  it('accepts only the scenarios it authored, and no extra instruction', async () => {
    expect((await replay('no-such-scenario')).status).toBe(404);
    expect((await replay(undefined)).status).toBe(404);
    expect((await replay({ id: 'attacker-1', type: 'payment.captured' })).status).toBe(404);
    expect((await replay('open', { payload: { id: 'attacker-1' } })).status).toBe(400);
    expect((await replay('open', { caseId: 'case-1' })).status).toBe(400);
  });

  it('leaves the canonical store and its published figures untouched', async () => {
    const before = await (await fetch(`${origin}/api/metrics`)).json() as Record<string, unknown>;

    for (const scenario of labScenarios()) await replayed(scenario.key);

    expect(await (await fetch(`${origin}/api/cases`)).json()).toEqual([]);
    expect(await (await fetch(`${origin}/api/metrics`)).json()).toEqual(before);
  });
});

describe('replay lab on an instance holding real credentials', () => {
  beforeEach(async () => { ({ server, origin } = await boot({ keyId: 'rzp_test_lab', keySecret: 'secret', webhookSecret: 'lab-hook-secret', clock: new FixedClock(NOW) })); });

  it('still replays, because it never touches the configured provider', async () => {
    // The lab builds its own simulator. An instance wired to Razorpay can therefore demonstrate the
    // boundary without any risk of a synthetic delivery reaching a real payment integration.
    const result = await replayed('open');

    expect(result.detail?.status).toBe('retry_scheduled');
    expect((await (await fetch(`${origin}/api/cases`)).json() as unknown[])).toEqual([]);
  });
});
