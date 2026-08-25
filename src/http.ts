import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RecoveryApplication } from './application.js';
import type { NormalizedEventInput } from './provider.js';
import { generateEvaluationCases, runEvaluation } from './evaluation.js';

function send(response: ServerResponse, status: number, body: string, contentType = 'application/json'): void {
  response.writeHead(status, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store' });
  response.end(body);
}

function dashboard(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recovery Loop</title><style>
body{font:16px system-ui;margin:0;background:#f6f7f9;color:#18202a}main{max-width:1100px;margin:auto;padding:32px}h1{margin-top:0}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{background:white;border:1px solid #dfe3e8;border-radius:10px;padding:16px}.label{color:#64748b;font-size:13px}.value{font-size:28px;font-weight:700;margin-top:6px}button{background:#155eef;color:white;border:0;border-radius:6px;padding:9px 12px;cursor:pointer}table{width:100%;margin-top:20px;background:white;border-collapse:collapse}th,td{text-align:left;padding:11px;border-bottom:1px solid #e5e7eb}code{background:#eef2ff;padding:2px 4px;border-radius:4px}.muted{color:#64748b}</style></head>
<body><main><h1>Recovery Loop</h1><p class="muted">Synthetic recovery control plane · AI recommends, deterministic policy authorizes.</p>
<button id="run">Run 60-case evaluation</button><section class="cards" id="cards"></section><h2>Recovery cases</h2><table><thead><tr><th>Case</th><th>Status</th><th>Amount</th><th>Actions</th><th>Audit events</th></tr></thead><tbody id="cases"></tbody></table></main>
<script>
const money=new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR'});
async function refresh(){const [m,c]=await Promise.all([fetch('/api/metrics').then(r=>r.json()),fetch('/api/cases').then(r=>r.json())]);document.querySelector('#cards').innerHTML=[['At risk',money.format(m.revenueAtRisk)],['Recovered',money.format(m.recoveredAmount)],['Recovery rate',(m.recoveryRate*100).toFixed(1)+'%'],['Escalated',m.escalated]].map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value">'+x[1]+'</div></div>').join('');document.querySelector('#cases').innerHTML=c.map(x=>'<tr><td><code>'+x.id+'</code></td><td>'+x.status+'</td><td>'+money.format(x.amount)+'</td><td>'+x.actions+'</td><td>'+x.audit+'</td></tr>').join('')||'<tr><td colspan="5">No cases yet. Run the evaluation.</td></tr>'}
document.querySelector('#run').onclick=async()=>{await fetch('/api/evaluation',{method:'POST'});await refresh()};refresh();
</script></body></html>`;
}

function readBody(request: IncomingMessage, maximumBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > maximumBytes) {
        reject(new Error('Webhook body is too large'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Projects a provider webhook body into the normalized event input, or undefined when unidentifiable. */
export function webhookInput(payload: Record<string, unknown>, fallbackId?: string): NormalizedEventInput | undefined {
  const metadata = typeof payload.metadata === 'object' && payload.metadata !== null ? payload.metadata as Record<string, unknown> : {};
  const nestedPayload = typeof payload.payload === 'object' && payload.payload !== null ? payload.payload as Record<string, unknown> : {};
  const payment = typeof nestedPayload.payment === 'object' && nestedPayload.payment !== null ? nestedPayload.payment as Record<string, unknown> : {};
  const entity = typeof payment.entity === 'object' && payment.entity !== null ? payment.entity as Record<string, unknown> : {};
  const notes = typeof entity.notes === 'object' && entity.notes !== null ? entity.notes as Record<string, unknown> : {};
  const caseId = stringValue(payload.caseId) ?? stringValue(metadata.caseId) ?? stringValue(notes.caseId);
  const id = stringValue(payload.id) ?? stringValue(payload.eventId) ?? fallbackId ?? stringValue(entity.id);
  const occurredAt = stringValue(payload.occurredAt) ?? stringValue(payload.createdAt) ?? new Date().toISOString();
  const rawType = stringValue(payload.type) ?? stringValue(payload.event);
  const type = rawType === 'payment.failed' || rawType === 'payment_failed' ? 'payment_failed'
    : rawType === 'payment.captured' || rawType === 'payment_succeeded' ? 'payment_succeeded'
      : rawType === 'payment.authorized' || rawType === 'payment_pending' ? 'payment_pending'
        : rawType === 'subscription.cancelled' || rawType === 'subscription_cancelled' ? 'subscription_cancelled'
          : rawType === 'dispute.created' || rawType === 'dispute_opened' ? 'dispute_opened' : 'unknown';
  if (!caseId || !id) return undefined;
  const providerPaymentId = stringValue(payload.providerPaymentId) ?? stringValue(entity.id);
  // Razorpay nests the method and failure code on the payment entity, but the domain reads them
  // off the event payload. Lift them here so a real body can still take the retry rung.
  const method = stringValue(payload.method) ?? stringValue(entity.method);
  const failureCode = stringValue(payload.failureCode) ?? stringValue(entity.error_code) ?? stringValue(entity.error_reason);
  return {
    id, type, caseId,
    ...(providerPaymentId === undefined ? {} : { providerPaymentId }),
    occurredAt,
    payload: { ...payload, ...(method === undefined ? {} : { method }), ...(failureCode === undefined ? {} : { failureCode }) },
  };
}

/**
 * The HTTP boundary. Every webhook is verified, parsed, and persisted here before any
 * orchestration runs, so an unsigned or unparseable delivery can never reach the workflow.
 */
export function createRequestListener(application: RecoveryApplication): (request: IncomingMessage, response: ServerResponse) => void {
  const { clock, provider, store, workflow } = application;
  let latestEvaluation: Awaited<ReturnType<typeof runEvaluation>> | undefined;

  async function metrics() {
    const cases = await store.all();
    if (latestEvaluation) {
      return {
        totalCases: latestEvaluation.totalCases,
        revenueAtRisk: latestEvaluation.revenueAtRisk,
        recoveredAmount: latestEvaluation.recoveredAmount,
        recoveryRate: latestEvaluation.recoveryRate,
        retryRecoveryRate: latestEvaluation.retryRecoveryRate,
        fallbackRecoveryRate: latestEvaluation.fallbackRecoveryRate,
        escalated: Math.round(latestEvaluation.escalationRate * latestEvaluation.totalCases),
        exhausted: Math.round(latestEvaluation.exhaustedRate * latestEvaluation.totalCases),
        synthetic: true,
      };
    }
    return {
      totalCases: cases.length,
      revenueAtRisk: cases.reduce((sum, recoveryCase) => sum + (recoveryCase.status === 'recovered' ? 0 : recoveryCase.context.amount), 0),
      recoveredAmount: cases.reduce((sum, recoveryCase) => sum + recoveryCase.recoveredAmount, 0),
      recoveryRate: cases.length === 0 ? 0 : cases.filter((recoveryCase) => recoveryCase.status === 'recovered').length / cases.length,
      escalated: cases.filter((recoveryCase) => recoveryCase.status === 'escalated').length,
      exhausted: cases.filter((recoveryCase) => recoveryCase.status === 'exhausted').length,
      synthetic: true,
    };
  }

  /** Opens a synthetic case and drives it, so the dashboard shows the same loop a webhook drives. */
  async function seedCase(caseId: string, renewal: Parameters<typeof workflow.openCase>[1]): Promise<void> {
    const at = clock.now().toISOString();
    await workflow.openCase(caseId, renewal);
    await workflow.ingestEvent(provider.normalizeEvent({ id: `${caseId}:failed`, type: 'payment_failed', caseId, occurredAt: at, payload: { method: 'recurring_mandate' } }, at));
    await workflow.drive(caseId);
  }

  async function webhook(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let rawBody: string;
    try {
      rawBody = await readBody(request);
    } catch (error) {
      return send(response, 413, JSON.stringify({ error: String(error) }));
    }
    // Signature first: an unverified body is never parsed, stored, or orchestrated.
    if (!provider.verifyEvent(rawBody, header(request, 'x-razorpay-signature') ?? '')) return send(response, 401, JSON.stringify({ error: 'Invalid webhook signature' }));
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Webhook JSON must be an object');
      payload = parsed as Record<string, unknown>;
    } catch (error) {
      return send(response, 400, JSON.stringify({ error: `Invalid webhook JSON: ${String(error)}` }));
    }
    const input = webhookInput(payload, header(request, 'x-razorpay-event-id'));
    if (!input) return send(response, 400, JSON.stringify({ error: 'Webhook is missing event id or case id' }));
    const event = provider.normalizeEvent(input, clock.now().toISOString());
    try {
      const existing = await store.get(event.caseId);
      const duplicate = existing?.events.some((candidate) => candidate.id === event.id) ?? false;
      if (!existing) {
        const context = payload.context;
        if (event.type !== 'payment_failed' || typeof context !== 'object' || context === null || Array.isArray(context)) {
          return send(response, 404, JSON.stringify({ error: `Recovery Case not found: ${event.caseId}` }));
        }
        const renewal = context as Record<string, unknown>;
        const required = ['customerId', 'subscriptionId', 'orderId', 'amount', 'currency', 'dueAt'];
        if (!required.every((key) => key in renewal) || typeof renewal.amount !== 'number') return send(response, 400, JSON.stringify({ error: 'Initial failed webhook is missing renewal context' }));
        await workflow.openCase(event.caseId, {
          customerId: String(renewal.customerId), subscriptionId: String(renewal.subscriptionId), orderId: String(renewal.orderId), amount: renewal.amount, currency: String(renewal.currency), dueAt: String(renewal.dueAt),
        });
      }
      const ingested = await workflow.ingestEvent(event);
      // Ingestion is the contract with the provider; driving the loop is what makes it recover.
      const result = duplicate ? ingested : await workflow.drive(event.caseId);
      return send(response, duplicate ? 200 : 202, JSON.stringify({ accepted: true, duplicate, caseId: result.id, status: result.status }));
    } catch (error) {
      return send(response, 422, JSON.stringify({ error: String(error) }));
    }
  }

  /** Applies an operator verdict to one case, or reports that the case does not exist. */
  async function operatorAction(response: ServerResponse, caseId: string, verdict: 'stop' | 'escalate'): Promise<void> {
    if (!(await store.get(caseId))) return send(response, 404, JSON.stringify({ error: `Recovery Case not found: ${caseId}` }));
    const result = verdict === 'stop' ? await workflow.stop(caseId) : await workflow.escalate(caseId);
    return send(response, 200, JSON.stringify({ caseId: result.id, status: result.status, outcome: result.outcome ?? null }));
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (request.method === 'POST' && url.pathname === '/webhooks/razorpay') return webhook(request, response);
    const operator = /^\/api\/cases\/(?<caseId>[^/]+)\/(?<verdict>stop|escalate)$/.exec(url.pathname);
    if (request.method === 'POST' && operator?.groups) {
      return operatorAction(response, decodeURIComponent(operator.groups.caseId ?? ''), operator.groups.verdict as 'stop' | 'escalate');
    }
    if (request.method === 'POST' && url.pathname === '/api/expire') {
      // Nothing else retires a lapsed fallback link, so the sweep is the loop's closing step.
      const swept = await Promise.all((await store.all()).map((recoveryCase) => workflow.expireLapsedFallbackLink(recoveryCase.id)));
      return send(response, 200, JSON.stringify({ expired: swept.filter((recoveryCase) => recoveryCase.status === 'exhausted').map((recoveryCase) => recoveryCase.id) }));
    }
    if (request.method === 'GET' && url.pathname === '/') return send(response, 200, dashboard(), 'text/html');
    if (request.method === 'GET' && url.pathname === '/api/metrics') return send(response, 200, JSON.stringify(await metrics()));
    if (request.method === 'GET' && url.pathname === '/api/cases') {
      return send(response, 200, JSON.stringify((await store.all()).map((recoveryCase) => ({ id: recoveryCase.id, status: recoveryCase.status, amount: recoveryCase.context.amount, actions: recoveryCase.actions.length, audit: recoveryCase.audit.length }))));
    }
    if (request.method === 'POST' && url.pathname === '/api/evaluation') {
      const evaluation = await runEvaluation(generateEvaluationCases(60, 42));
      latestEvaluation = evaluation;
      for (const evaluationCase of evaluation.cases) {
        if (!(await store.get(evaluationCase.id))) await seedCase(evaluationCase.id, evaluationCase.context);
      }
      return send(response, 200, JSON.stringify(evaluation));
    }
    send(response, 404, JSON.stringify({ error: 'Not found' }));
  }

  return (request, response) => {
    void handle(request, response).catch((error: unknown) => send(response, 500, JSON.stringify({ error: String(error) })));
  };
}
