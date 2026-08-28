import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRecoveryApplication } from '../src/application.js';
import { createRequestListener, type CaseDetail, type CaseSummary } from '../src/http.js';
import { DeterministicSimulator, FixedClock } from '../src/provider.js';
import { InMemoryRecoveryStore } from '../src/recovery.js';

const SIMULATOR_SECRET = 'test-simulator-secret';
const CONTROL_TOKEN = 'test-control-token';
const config = { port: 0, logLevel: 'info' as const, simulatorWebhookSecret: SIMULATOR_SECRET, controlPlaneToken: CONTROL_TOKEN, razorpayRecurringRetryEnabled: false, requireDatabase: false };
const context = { customerId: 'customer-1', subscriptionId: 'subscription-1', orderId: 'order-1', amount: 1200, currency: 'INR', dueAt: '2026-01-01T00:00:00.000Z' };

let server: Server;
let origin: string;
let store: InMemoryRecoveryStore;

beforeEach(async () => {
  store = new InMemoryRecoveryStore();
  const application = createRecoveryApplication({ config, clock: new FixedClock('2026-01-01T00:00:00.000Z'), store });
  server = createServer(createRequestListener(application));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

/** Posts a webhook body, signing it the way the deterministic simulator expects unless told otherwise. */
async function post(body: unknown, signature?: string): Promise<Response> {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return fetch(`${origin}/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature ?? createHmac('sha256', SIMULATOR_SECRET).update(raw).digest('hex') },
    body: raw,
  });
}

/** The control plane, exercised the way an operator's tooling would. */
async function control(path: string, body?: unknown, token: string | undefined = CONTROL_TOKEN): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Registers the renewal before any delivery names it, because a webhook may not invent one. */
async function register(id = 'case-1', renewal = context): Promise<Response> {
  return control('/api/recovery-cases', { id, context: renewal });
}

function failedRenewal(id = 'event-1') {
  return { id, type: 'payment.failed', caseId: 'case-1', occurredAt: '2026-01-01T00:00:00.000Z', payload: { payment: { entity: { method: 'recurring_mandate' } } } };
}

describe('webhook boundary', () => {
  it('drives a registered Recovery Case from a signed failed-renewal delivery', async () => {
    await register();

    const response = await post(failedRenewal());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, duplicate: false, caseId: 'case-1' });
    expect((await store.get('case-1'))?.context.amount).toBe(1200);
  });

  it('refuses a delivery for a renewal nobody registered', async () => {
    // Renewal context is merchant data. If a signed body could carry it, whoever holds the webhook
    // secret could invent customers and amounts, and every published figure would be theirs to set.
    const response = await post({ ...failedRenewal(), context });

    expect(response.status).toBe(404);
    expect(await store.all()).toHaveLength(0);
  });

  it('rejects an invalid signature without creating a case, an event, or an action', async () => {
    const response = await post(failedRenewal(), 'sha256=forged');

    expect(response.status).toBe(401);
    expect(await store.get('case-1')).toBeUndefined();
    expect(await store.all()).toHaveLength(0);
  });

  it('rejects a body whose signature was computed over different content', async () => {
    const response = await post(failedRenewal(), createHmac('sha256', SIMULATOR_SECRET).update(JSON.stringify(failedRenewal('other'))).digest('hex'));

    expect(response.status).toBe(401);
    expect(await store.all()).toHaveLength(0);
  });

  it('treats a redelivered event as one logical event and adds no second attempt or action', async () => {
    await register();
    const first = await post(failedRenewal());
    expect(await first.json()).toMatchObject({ status: 'retry_scheduled' });

    const repeat = await post(failedRenewal());

    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toMatchObject({ duplicate: true });
    const recoveryCase = await store.get('case-1');
    expect(recoveryCase?.events).toHaveLength(1);
    expect(recoveryCase?.attempts).toHaveLength(1);
    expect(recoveryCase?.actions).toHaveLength(1);
  });

  it('takes the retry rung for a Razorpay-shaped body that carries a recurring mandate', async () => {
    await register();
    await post(failedRenewal());

    const recoveryCase = await store.get('case-1');
    expect(recoveryCase?.attempts[0]?.method).toBe('recurring_mandate');
    expect(recoveryCase?.actions.map((action) => action.kind)).toEqual(['retry']);
  });

  it('rejects malformed JSON', async () => {
    const response = await post('{"id":"event-1"');

    expect(response.status).toBe(400);
    expect(await store.all()).toHaveLength(0);
  });

  it('rejects a JSON array, which carries no event identity', async () => {
    const response = await post([failedRenewal()]);

    expect(response.status).toBe(400);
    expect(await store.all()).toHaveLength(0);
  });

  it('rejects a delivery with no resolvable case id', async () => {
    const { caseId, ...withoutCase } = failedRenewal();
    void caseId;

    const response = await post(withoutCase);

    expect(response.status).toBe(400);
  });

  it('correlates a delivery to an existing case through Razorpay payment notes', async () => {
    await register();
    await post(failedRenewal());

    const response = await post({
      id: 'event-2', type: 'payment.captured', occurredAt: '2026-01-01T00:00:05.000Z',
      payload: { payment: { entity: { id: 'pay_1', notes: { caseId: 'case-1' } } } },
    });

    expect(response.status).toBe(202);
    expect((await store.get('case-1'))?.events).toHaveLength(2);
  });

  it('refuses to open a case for an event that is not a failed renewal', async () => {
    const response = await post({ id: 'event-9', type: 'payment.captured', caseId: 'case-unknown', occurredAt: '2026-01-01T00:00:00.000Z' });

    expect(response.status).toBe(404);
    expect(await store.all()).toHaveLength(0);
  });

  it('refuses to register a renewal whose context is incomplete', async () => {
    const response = await control('/api/recovery-cases', { id: 'case-1', context: { customerId: 'customer-1', amount: 1200 } });

    expect(response.status).toBe(400);
    expect(await store.all()).toHaveLength(0);
  });

  it('registers a renewal once, tolerates the same registration again, and refuses a different one', async () => {
    expect((await register()).status).toBe(201);
    const again = await register();
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ registered: false });

    const conflicting = await register('case-1', { ...context, amount: 9999 });

    expect(conflicting.status).toBe(409);
    expect((await store.get('case-1'))?.context.amount).toBe(1200);
  });

  it('records an unsupported event type without acting on the case', async () => {
    await register();
    await post(failedRenewal());

    const before = await store.get('case-1');

    const response = await post({ id: 'event-3', type: 'payout.processed', caseId: 'case-1', occurredAt: '2026-01-01T00:00:06.000Z' });

    expect(response.status).toBe(202);
    const recoveryCase = await store.get('case-1');
    expect(recoveryCase?.status).toBe(before?.status);
    expect(recoveryCase?.actions).toHaveLength(before?.actions.length ?? 0);
    expect(recoveryCase?.events.map((event) => event.type)).toEqual(['payment_failed', 'unknown']);
  });

  it('serves the dashboard and the case and metric projections', async () => {
    await register();
    await post(failedRenewal());

    const [dashboard, cases, metrics] = await Promise.all([fetch(origin), fetch(`${origin}/api/cases`), fetch(`${origin}/api/metrics`)]);

    expect(dashboard.headers.get('content-type')).toContain('text/html');
    expect(await cases.json()).toMatchObject([{ id: 'case-1', status: 'retry_scheduled', amount: 1200 }]);
    expect(await metrics.json()).toMatchObject({ totalCases: 1, revenueAtRisk: 1200, recoveredAmount: 0 });
  });

  it('stops counting a case as revenue at risk once it reaches a terminal outcome', async () => {
    // CONTEXT.md: Revenue at Risk "is not counted after the case reaches a terminal outcome."
    // An escalated renewal is a human's problem now, not an open recovery opportunity.
    await register();
    await post(failedRenewal());
    expect(await fetch(`${origin}/api/metrics`).then((response) => response.json())).toMatchObject({ revenueAtRisk: 1200 });

    await control('/api/cases/case-1/escalate');

    expect(await fetch(`${origin}/api/metrics`).then((response) => response.json())).toMatchObject({ revenueAtRisk: 0, escalated: 1 });
  });

  it('reports readiness and the storage it is actually using', async () => {
    const response = await fetch(`${origin}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, persistence: 'memory' });
  });

  it('fails readiness without naming the database it could not reach', async () => {
    const failing = { ...store, healthCheck: async () => { throw new Error('connect ECONNREFUSED postgres://user:pw@db.internal:5432'); } } as unknown as InMemoryRecoveryStore;
    const application = createRecoveryApplication({ config, clock: new FixedClock('2026-01-01T00:00:00.000Z'), store: failing });
    const unhealthy = createServer(createRequestListener(application));
    await new Promise<void>((resolve) => unhealthy.listen(0, '127.0.0.1', resolve));
    const unhealthyOrigin = `http://127.0.0.1:${(unhealthy.address() as AddressInfo).port}`;

    const response = await fetch(`${unhealthyOrigin}/healthz`);
    const body = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(body)).toMatchObject({ ok: false });
    // A driver error names the host, the database, and often the credentials it failed with.
    expect(body).not.toContain('postgres://');
    expect(body).not.toContain('ECONNREFUSED');
    await new Promise<void>((resolve, reject) => unhealthy.close((error) => (error ? reject(error) : resolve())));
  });

  it('answers an unknown route with 404', async () => {
    expect((await fetch(`${origin}/nope`)).status).toBe(404);
  });
});

describe('operator surface', () => {
  it('stops a live case on request', async () => {
    await register();
    await post(failedRenewal());

    const response = await control('/api/cases/case-1/stop');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ caseId: 'case-1', status: 'stopped', outcome: 'stopped' });
    expect((await store.get('case-1'))?.audit.map((entry) => entry.type)).toContain('manual_stop');
  });

  it('escalates a live case on request', async () => {
    await register();
    await post(failedRenewal());

    const response = await control('/api/cases/case-1/escalate');

    expect(await response.json()).toMatchObject({ status: 'escalated', outcome: 'escalated' });
  });

  it('reports an operator verdict on a case that does not exist', async () => {
    expect((await control('/api/cases/case-nope/stop')).status).toBe(404);
  });

  it('refuses every state-changing route without the control-plane token', async () => {
    await register();
    await post(failedRenewal());

    for (const path of ['/api/cases/case-1/stop', '/api/cases/case-1/escalate', '/api/expire', '/api/evaluation', '/api/recovery-cases']) {
      expect((await control(path, { id: 'case-2', context }, 'wrong-token')).status).toBe(401);
      expect((await fetch(`${origin}${path}`, { method: 'POST' })).status).toBe(401);
    }
    // Nothing moved: the token is checked before the body is read or the case is looked up.
    expect((await store.get('case-1'))?.status).toBe('retry_scheduled');
    expect(await store.get('case-2')).toBeUndefined();
  });

  it('sweeps lapsed fallback links and reports the cases it exhausted', async () => {
    await register();
    await post(failedRenewal());

    const response = await control('/api/expire');

    // Nothing has been offered a link yet, so the sweep finds nothing due and exhausts nothing.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inspected: 0, expiredCaseIds: [], moreDue: false });
    expect((await store.get('case-1'))?.status).toBe('retry_scheduled');
  });
});

describe('case drill-down', () => {
  it('projects one case from failure through diagnosis, policy, actions, and audit timeline', async () => {
    await register();
    await post(failedRenewal());

    const response = await fetch(`${origin}/api/cases/case-1`);

    expect(response.status).toBe(200);
    const detail = await response.json() as CaseDetail;
    expect(detail).toMatchObject({ id: 'case-1', status: 'retry_scheduled', context, recoveredAmount: 0 });
    // The operator has to be able to see why the model recommended what it did.
    expect(detail.diagnosis).toMatchObject({ failureCategory: 'transient', recommendedAction: 'retry' });
    expect(detail.diagnosis?.evidence.length).toBeGreaterThan(0);
    expect(typeof detail.diagnosis?.explanation).toBe('string');
    // ...and why deterministic policy allowed or blocked it.
    expect(detail.decisions[0]).toMatchObject({ action: 'retry', allowed: true });
    expect(typeof detail.decisions[0]?.reason).toBe('string');
    expect(detail.actions.map((action) => action.kind)).toEqual(['retry']);
    expect(detail.attempts.length).toBeGreaterThan(0);
    expect(detail.events.map((event) => event.type)).toEqual(['payment_failed']);
    expect(detail.audit.length).toBeGreaterThan(0);
    expect(detail.audit[0]).toMatchObject({ caseId: 'case-1' });
    expect(typeof detail.audit[0]?.actor).toBe('string');
  });

  it('previews no fallback message while the case is still on the retry rung', async () => {
    await register();
    await post(failedRenewal());

    const detail = await fetch(`${origin}/api/cases/case-1`).then((response) => response.json()) as CaseDetail;

    expect(detail.actions.map((action) => action.kind)).toEqual(['retry']);
    expect(detail.fallbackMessage).toBeNull();
  });

  it('reports a case that does not exist', async () => {
    const response = await fetch(`${origin}/api/cases/case-nope`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('case-nope') });
  });

  it('filters the case list by status', async () => {
    await register();
    await post(failedRenewal());

    const [matching, other] = await Promise.all([
      fetch(`${origin}/api/cases?status=retry_scheduled`).then((response) => response.json()),
      fetch(`${origin}/api/cases?status=recovered`).then((response) => response.json()),
    ]);

    expect(matching).toMatchObject([{ id: 'case-1' }]);
    expect(other).toEqual([]);
  });

  it('rejects a filter no case status can satisfy instead of silently returning nothing', async () => {
    const response = await fetch(`${origin}/api/cases?status=not_a_status`);

    expect(response.status).toBe(400);
  });

  it('carries the customer and outcome the case list is filtered and read by', async () => {
    await register();
    await post(failedRenewal());
    await control('/api/cases/case-1/stop');

    expect(await fetch(`${origin}/api/cases`).then((response) => response.json())).toMatchObject([
      { id: 'case-1', status: 'stopped', outcome: 'stopped', customerId: 'customer-1', currency: 'INR' },
    ]);
  });
});

describe('evaluation projection', () => {
  it('reports that no batch has run yet', async () => {
    const response = await fetch(`${origin}/api/evaluation`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ available: false });
  });

  it('replays the last batch without re-running it', async () => {
    const ran = await control('/api/evaluation').then((response) => response.json()) as { metrics: unknown; results: unknown[] };

    const replayed = await fetch(`${origin}/api/evaluation`).then((response) => response.json()) as { available: boolean; metrics: unknown; results: unknown[] };

    expect(replayed.available).toBe(true);
    expect(replayed.metrics).toEqual(ran.metrics);
    expect(replayed.results).toHaveLength(ran.results.length);
  });

  it('carries the ground truth and the runtime result the evaluation panel compares', async () => {
    const batch = await control('/api/evaluation').then((response) => response.json()) as { results: Record<string, unknown>[] };

    // Expected safe action and outcome are ground truth; the authorized action and status are
    // what the loop actually did. The panel puts them side by side, so both must be projected.
    expect(batch.results[0]).toMatchObject({
      caseId: expect.any(String),
      archetype: expect.any(String),
      expected: { safeAction: expect.any(String), outcome: expect.any(String) },
      firstAuthorizedAction: expect.any(String),
      outcome: expect.any(String),
      recoveryPath: expect.any(String),
      recoveredAmount: expect.any(Number),
      status: expect.any(String),
    });
  });
});

describe('live and published figures', () => {
  it('keeps reporting live cases after a batch is published, and reports the batch beside them', async () => {
    await register();
    await post(failedRenewal());
    const beforeBatch = await fetch(`${origin}/api/metrics`).then((response) => response.json()) as Record<string, unknown>;
    expect(beforeBatch).toMatchObject({ totalCases: 1, revenueAtRisk: 1200, batch: null });

    await control('/api/evaluation');

    const afterBatch = await fetch(`${origin}/api/metrics`).then((response) => response.json()) as { totalCases: number; batch: { seed: number; totalCases: number } | null };
    // The batch drove 60 more cases through the loop, so the live projection grows with them —
    // a published batch reports beside the live figures rather than replacing them for good.
    expect(afterBatch.totalCases).toBe(61);
    expect(afterBatch.batch).toMatchObject({ seed: 42, totalCases: 60, synthetic: true });

    // A case registered and ingested after the batch still moves the live figures.
    await register('case-9');
    await post({ id: 'event-9', type: 'payment.failed', caseId: 'case-9', occurredAt: '2026-01-01T00:09:00.000Z', payload: { payment: { entity: { method: 'card' } } } });

    expect(await fetch(`${origin}/api/metrics`).then((response) => response.json())).toMatchObject({ totalCases: 62 });
  });
});

describe('dashboard demo path', () => {
  it('walks failure, diagnosis, policy, operator verdict, and audit through the projections the dashboard reads', async () => {
    await register();
    await post(failedRenewal());

    const listed = await fetch(`${origin}/api/cases?status=retry_scheduled`).then((response) => response.json()) as CaseSummary[];
    const opened = await fetch(`${origin}/api/cases/${listed[0]!.id}`).then((response) => response.json()) as CaseDetail;
    expect(opened.diagnosis?.recommendedAction).toBe('retry');
    expect(opened.decisions.some((decision) => decision.allowed)).toBe(true);

    await control('/api/cases/case-1/escalate');

    const after = await fetch(`${origin}/api/cases/case-1`).then((response) => response.json()) as CaseDetail;
    expect(after.status).toBe('escalated');
    expect(after.audit.map((entry) => entry.type)).toContain('manual_escalation');
    expect(after.audit.some((entry) => entry.actor === 'operator')).toBe(true);
    expect(await fetch(`${origin}/api/metrics`).then((response) => response.json())).toMatchObject({ escalated: 1 });
  });

  it('advances a simulated result and shows recovered metrics and audit events through the same projections', async () => {
    await register();
    await post(failedRenewal());
    const authorized = await fetch(`${origin}/api/cases/case-1`).then((response) => response.json()) as CaseDetail;
    expect(authorized.actions.map((action) => action.kind)).toEqual(['retry']);

    // The provider settles the authorized retry: this is the demo's "advance a simulated result".
    await post({ id: 'event-2', type: 'payment.captured', caseId: 'case-1', providerPaymentId: 'sim_retry_case-1', occurredAt: '2026-01-01T00:05:00.000Z' });

    const recovered = await fetch(`${origin}/api/cases/case-1`).then((response) => response.json()) as CaseDetail;
    expect(recovered.status).toBe('recovered');
    expect(recovered.recoveredAmount).toBe(1200);
    expect(recovered.audit.some((entry) => entry.actor === 'provider')).toBe(true);
    expect(await fetch(`${origin}/api/metrics`).then((response) => response.json())).toMatchObject({ recoveredAmount: 1200, recoveryRate: 1, revenueAtRisk: 0 });
    expect(await fetch(`${origin}/api/cases?status=recovered`).then((response) => response.json())).toMatchObject([{ id: 'case-1', recoveredAmount: 1200 }]);
  });

  it('credits a link a customer paid, reading the action identity out of Razorpay\'s own body', async () => {
    // Razorpay reports a paid link as a payment under its own id, naming the link in a sibling
    // entity. Without reading that, the money looks like a payment nothing on the case can claim.
    await register();
    await post(failedRenewal());
    const authorized = await store.get('case-1');
    expect(authorized?.actions.find((candidate) => candidate.kind === 'retry')?.providerReference).toBe('sim_retry_case-1');

    await post({
      id: 'event-2',
      type: 'payment.captured',
      caseId: 'case-1',
      occurredAt: '2026-01-01T00:05:00.000Z',
      payload: {
        payment: { entity: { id: 'pay_customer_paid', notes: { recoveryActionKey: 'case-1:retry' } } },
        payment_link: { entity: { id: 'plink_demo', notes: { caseId: 'case-1' } } },
      },
    });

    const recovered = await fetch(`${origin}/api/cases/case-1`).then((response) => response.json()) as CaseDetail;
    expect(recovered.status).toBe('recovered');
    expect(recovered.recoveredAmount).toBe(1200);
  });

  it('serves a dashboard whose script parses, so a syntax slip cannot ship as a blank page', async () => {
    const html = await fetch(origin).then((response) => response.text());

    const script = /<script>(?<body>[\s\S]*)<\/script>/.exec(html)?.groups?.body ?? '';
    expect(script.length).toBeGreaterThan(0);
    expect(() => new Function(script)).not.toThrow();
  });

  it('keeps the control plane out of the page a visitor is served', async () => {
    const html = await fetch(origin).then((response) => response.text());

    // The read-only projections the dashboard is built from are all still there.
    for (const fragment of ['/api/cases/', '/api/metrics', '/api/evaluation', 'status=', '/api/lab/replay']) {
      expect(html).toContain(fragment);
    }
    // Nothing a visitor can press writes, and the token never reaches the browser at all.
    for (const fragment of ['/stop', '/escalate', '/api/expire', '/api/recovery-cases', CONTROL_TOKEN, 'Bearer']) {
      expect(html).not.toContain(fragment);
    }
  });

  it('serves the dashboard with the minimal shadcn-style visual primitives', async () => {
    const html = await fetch(origin).then((response) => response.text());

    for (const fragment of ['data-shell', 'data-card', 'data-badge', 'data-table-wrap', 'data-section-heading']) {
      expect(html).toContain(fragment);
    }
  });

  it('serves a persisted accessible theme toggle', async () => {
    const html = await fetch(origin).then((response) => response.text());

    for (const fragment of ['data-theme-toggle', 'aria-pressed', 'localStorage', 'data-theme="dark"']) {
      expect(html).toContain(fragment);
    }
  });

  it('uses high-contrast dark success and danger badges', async () => {
    const html = await fetch(origin).then((response) => response.text());

    for (const fragment of ['--success-bg:#166534', '--danger-bg:#991b1b', ':root[data-theme="dark"] .badge-success,:root[data-theme="dark"] .badge-danger{border-color:#fff;color:#fff}', '--primary-muted:#64748b', '.button-meta{color:var(--primary-muted)']) {
      expect(html).toContain(fragment);
    }
  });

  it('serves native buttons for opening recovery cases from either table', async () => {
    const html = await fetch(origin).then((response) => response.text());

    for (const fragment of ['class="case-link"', 'aria-label="Open recovery case ', "querySelectorAll('button.case-link')"]) {
      expect(html).toContain(fragment);
    }
  });
});

describe('fallback message preview', () => {
  let linkServer: Server;
  let linkOrigin: string;

  beforeEach(async () => {
    // The retry is unsupported for this case, so policy steps the case down to the link rung.
    const provider = new DeterministicSimulator(new Map([['case-1', { retry: 'unsupported', fallback: 'success', diagnosis: 'transient' }]]), new FixedClock('2026-01-01T00:00:00.000Z'), SIMULATOR_SECRET);
    const application = createRecoveryApplication({ config, clock: new FixedClock('2026-01-01T00:00:00.000Z'), store: new InMemoryRecoveryStore(), provider });
    linkServer = createServer(createRequestListener(application));
    await new Promise<void>((resolve) => linkServer.listen(0, '127.0.0.1', resolve));
    linkOrigin = `http://127.0.0.1:${(linkServer.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => linkServer.close((error) => (error ? reject(error) : resolve())));
  });

  async function openCase(): Promise<void> {
    await fetch(`${linkOrigin}/api/recovery-cases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${CONTROL_TOKEN}` },
      body: JSON.stringify({ id: 'case-1', context }),
    });
    const raw = JSON.stringify(failedRenewal());
    await fetch(`${linkOrigin}/webhooks/razorpay`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-razorpay-signature': createHmac('sha256', SIMULATOR_SECRET).update(raw).digest('hex') }, body: raw });
  }

  it('previews the fallback message once a link exists, and marks it undeliverable', async () => {
    await openCase();

    const detail = await fetch(`${linkOrigin}/api/cases/case-1`).then((response) => response.json()) as CaseDetail;

    expect(detail.actions.map((action) => action.kind)).toEqual(['fallback_link']);
    // The MVP previews the customer message; it integrates no email, SMS, WhatsApp, or voice.
    expect(detail.fallbackMessage).toMatchObject({ customerId: 'customer-1', expired: false, deliverable: false });
    expect(detail.fallbackMessage?.body).toContain('INR 12.00');
    expect(detail.fallbackMessage?.linkReference).toBe('sim_link_case-1');
  });

});
