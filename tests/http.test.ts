import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRecoveryApplication } from '../src/application.js';
import { createRequestListener, type CaseDetail, type CaseSummary } from '../src/http.js';
import { FixedClock } from '../src/provider.js';
import { InMemoryRecoveryStore } from '../src/recovery.js';

const config = { port: 0, logLevel: 'info' as const };
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
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': signature ?? `sim:${raw}` },
    body: raw,
  });
}

function failedRenewal(id = 'event-1') {
  return { id, type: 'payment.failed', caseId: 'case-1', occurredAt: '2026-01-01T00:00:00.000Z', context, payload: { payment: { entity: { method: 'recurring_mandate' } } } };
}

describe('webhook boundary', () => {
  it('opens a Recovery Case from a signed failed-renewal delivery', async () => {
    const response = await post(failedRenewal());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, duplicate: false, caseId: 'case-1' });
    expect((await store.get('case-1'))?.context.amount).toBe(1200);
  });

  it('rejects an invalid signature without creating a case, an event, or an action', async () => {
    const response = await post(failedRenewal(), 'sha256=forged');

    expect(response.status).toBe(401);
    expect(await store.get('case-1')).toBeUndefined();
    expect(await store.all()).toHaveLength(0);
  });

  it('rejects a body whose signature was computed over different content', async () => {
    const response = await post(failedRenewal(), `sim:${JSON.stringify(failedRenewal('other'))}`);

    expect(response.status).toBe(401);
    expect(await store.all()).toHaveLength(0);
  });

  it('treats a redelivered event as one logical event and adds no second attempt or action', async () => {
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
    await post(failedRenewal());

    const recoveryCase = await store.get('case-1');
    expect(recoveryCase?.attempts[0]?.method).toBe('recurring_mandate');
    expect(recoveryCase?.actions.map((action) => action.kind)).toEqual(['retry']);
  });

  it('rejects malformed JSON', async () => {
    // No trailing whitespace: the simulator's signature is the raw body echoed in a header,
    // and HTTP header values are trimmed in transit.
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

  it('refuses to open a case when the renewal context is incomplete', async () => {
    const response = await post({ ...failedRenewal(), context: { customerId: 'customer-1' } });

    expect(response.status).toBe(400);
    expect(await store.all()).toHaveLength(0);
  });

  it('records an unsupported event type without acting on the case', async () => {
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
    await post(failedRenewal());

    const [dashboard, cases, metrics] = await Promise.all([fetch(origin), fetch(`${origin}/api/cases`), fetch(`${origin}/api/metrics`)]);

    expect(dashboard.headers.get('content-type')).toContain('text/html');
    expect(await cases.json()).toMatchObject([{ id: 'case-1', status: 'retry_scheduled', amount: 1200 }]);
    expect(await metrics.json()).toMatchObject({ totalCases: 1, revenueAtRisk: 1200, recoveredAmount: 0 });
  });

  it('answers an unknown route with 404', async () => {
    expect((await fetch(`${origin}/nope`)).status).toBe(404);
  });
});

describe('operator surface', () => {
  it('stops a live case on request', async () => {
    await post(failedRenewal());

    const response = await fetch(`${origin}/api/cases/case-1/stop`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ caseId: 'case-1', status: 'stopped', outcome: 'stopped' });
    expect((await store.get('case-1'))?.audit.map((entry) => entry.type)).toContain('manual_stop');
  });

  it('escalates a live case on request', async () => {
    await post(failedRenewal());

    const response = await fetch(`${origin}/api/cases/case-1/escalate`, { method: 'POST' });

    expect(await response.json()).toMatchObject({ status: 'escalated', outcome: 'escalated' });
  });

  it('reports an operator verdict on a case that does not exist', async () => {
    expect((await fetch(`${origin}/api/cases/case-nope/stop`, { method: 'POST' })).status).toBe(404);
  });

  it('sweeps lapsed fallback links and reports the cases it exhausted', async () => {
    await post(failedRenewal());

    const response = await fetch(`${origin}/api/expire`, { method: 'POST' });

    // Nothing has been offered a link yet, so the sweep exhausts nothing.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ expired: [] });
    expect((await store.get('case-1'))?.status).toBe('retry_scheduled');
  });
});

describe('case drill-down', () => {
  it('projects one case from failure through diagnosis, policy, actions, and audit timeline', async () => {
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

  it('reports a case that does not exist', async () => {
    const response = await fetch(`${origin}/api/cases/case-nope`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining('case-nope') });
  });

  it('filters the case list by status', async () => {
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
    await post(failedRenewal());
    await fetch(`${origin}/api/cases/case-1/stop`, { method: 'POST' });

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
    const ran = await fetch(`${origin}/api/evaluation`, { method: 'POST' }).then((response) => response.json()) as { metrics: unknown; results: unknown[] };

    const replayed = await fetch(`${origin}/api/evaluation`).then((response) => response.json()) as { available: boolean; metrics: unknown; results: unknown[] };

    expect(replayed.available).toBe(true);
    expect(replayed.metrics).toEqual(ran.metrics);
    expect(replayed.results).toHaveLength(ran.results.length);
  });

  it('carries the ground truth and the runtime result the evaluation panel compares', async () => {
    const batch = await fetch(`${origin}/api/evaluation`, { method: 'POST' }).then((response) => response.json()) as { results: Record<string, unknown>[] };

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

describe('dashboard demo path', () => {
  it('walks failure, diagnosis, policy, operator verdict, and audit through the projections the dashboard reads', async () => {
    await post(failedRenewal());

    const listed = await fetch(`${origin}/api/cases?status=retry_scheduled`).then((response) => response.json()) as CaseSummary[];
    const opened = await fetch(`${origin}/api/cases/${listed[0]!.id}`).then((response) => response.json()) as CaseDetail;
    expect(opened.diagnosis?.recommendedAction).toBe('retry');
    expect(opened.decisions.some((decision) => decision.allowed)).toBe(true);

    await fetch(`${origin}/api/cases/case-1/escalate`, { method: 'POST' });

    const after = await fetch(`${origin}/api/cases/case-1`).then((response) => response.json()) as CaseDetail;
    expect(after.status).toBe('escalated');
    expect(after.audit.map((entry) => entry.type)).toContain('manual_escalation');
    expect(after.audit.some((entry) => entry.actor === 'operator')).toBe(true);
    expect(await fetch(`${origin}/api/metrics`).then((response) => response.json())).toMatchObject({ escalated: 1 });
  });

  it('advances a simulated result and shows recovered metrics and audit events through the same projections', async () => {
    await post(failedRenewal());
    const authorized = await fetch(`${origin}/api/cases/case-1`).then((response) => response.json()) as CaseDetail;
    expect(authorized.actions.map((action) => action.kind)).toEqual(['retry']);

    // The provider settles the authorized retry: this is the demo's "advance a simulated result".
    await post({ id: 'event-2', type: 'payment.captured', caseId: 'case-1', occurredAt: '2026-01-01T00:05:00.000Z' });

    const recovered = await fetch(`${origin}/api/cases/case-1`).then((response) => response.json()) as CaseDetail;
    expect(recovered.status).toBe('recovered');
    expect(recovered.recoveredAmount).toBe(1200);
    expect(recovered.audit.some((entry) => entry.actor === 'provider')).toBe(true);
    expect(await fetch(`${origin}/api/metrics`).then((response) => response.json())).toMatchObject({ recoveredAmount: 1200, recoveryRate: 1, revenueAtRisk: 0 });
    expect(await fetch(`${origin}/api/cases?status=recovered`).then((response) => response.json())).toMatchObject([{ id: 'case-1', recoveredAmount: 1200 }]);
  });

  it('serves a dashboard whose script parses, so a syntax slip cannot ship as a blank page', async () => {
    const html = await fetch(origin).then((response) => response.text());

    const script = /<script>(?<body>[\s\S]*)<\/script>/.exec(html)?.groups?.body ?? '';
    expect(script.length).toBeGreaterThan(0);
    expect(() => new Function(script)).not.toThrow();
  });

  it('serves a dashboard that reaches the drill-down, filter, and operator endpoints', async () => {
    const html = await fetch(origin).then((response) => response.text());

    for (const fragment of ['/api/cases/', '/api/metrics', '/api/evaluation', 'status=', '/stop', '/escalate']) {
      expect(html).toContain(fragment);
    }
  });
});
