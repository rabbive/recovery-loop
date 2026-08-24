import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { FixedClock, type NormalizedEventInput } from './provider.js';
import { createRecoveryApplication } from './application.js';
import { loadConfig } from './config.js';
import { generateEvaluationCases, runEvaluation } from './evaluation.js';

const config = loadConfig();
const application = createRecoveryApplication({ config, clock: new FixedClock('2026-01-01T00:00:00.000Z') });
const { clock, postgresStore, provider, store, workflow } = application;
const webhookProvider = provider;
let latestEvaluation: Awaited<ReturnType<typeof runEvaluation>> | undefined;

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

function webhookInput(payload: Record<string, unknown>, fallbackId?: string): NormalizedEventInput | undefined {
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
  const providerPaymentId = stringValue(payload.providerPaymentId);
  return { id, type, caseId, ...(providerPaymentId === undefined ? {} : { providerPaymentId }), occurredAt, payload };
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'POST' && url.pathname === '/webhooks/razorpay') {
    let rawBody: string;
    try {
      rawBody = await readBody(request);
    } catch (error) {
      return send(response, 413, JSON.stringify({ error: String(error) }));
    }
    const signature = request.headers['x-razorpay-signature'];
    const signatureValue = (Array.isArray(signature) ? signature[0] : signature) ?? '';
    if (!webhookProvider.verifyEvent(rawBody, signatureValue)) return send(response, 400, JSON.stringify({ error: 'Invalid webhook signature' }));
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(rawBody);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Webhook JSON must be an object');
      payload = parsed as Record<string, unknown>;
    } catch (error) {
      return send(response, 400, JSON.stringify({ error: `Invalid webhook JSON: ${String(error)}` }));
    }
    const eventHeader = request.headers['x-razorpay-event-id'];
    const eventHeaderValue = (Array.isArray(eventHeader) ? eventHeader[0] : eventHeader) ?? undefined;
    const input = webhookInput(payload, eventHeaderValue);
    if (!input) return send(response, 400, JSON.stringify({ error: 'Webhook is missing event id or case id' }));
    const event = webhookProvider.normalizeEvent(input, clock.now().toISOString());
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
      const result = await workflow.ingestEvent(event);
      return send(response, duplicate ? 200 : 202, JSON.stringify({ accepted: true, duplicate, caseId: result.id, status: result.status }));
    } catch (error) {
      return send(response, 422, JSON.stringify({ error: String(error) }));
    }
  }
  if (request.method === 'GET' && url.pathname === '/') return send(response, 200, dashboard(), 'text/html');
  if (request.method === 'GET' && url.pathname === '/api/metrics') return send(response, 200, JSON.stringify(await metrics()));
  if (request.method === 'GET' && url.pathname === '/api/cases') return send(response, 200, JSON.stringify((await store.all()).map((recoveryCase) => ({ id: recoveryCase.id, status: recoveryCase.status, amount: recoveryCase.context.amount, actions: recoveryCase.actions.length, audit: recoveryCase.audit.length }))));
  if (request.method === 'POST' && url.pathname === '/api/evaluation') {
    const evaluation = await runEvaluation(generateEvaluationCases(60, 42));
    latestEvaluation = evaluation;
    for (const evaluationCase of evaluation.cases) {
      if (!(await store.get(evaluationCase.id))) {
        await workflow.openCase(evaluationCase.id, evaluationCase.context);
        await workflow.ingestEvent(provider.normalizeEvent({ id: `${evaluationCase.id}:failed`, type: 'payment_failed', caseId: evaluationCase.id, occurredAt: clock.now().toISOString(), payload: { method: 'recurring_mandate' } }, clock.now().toISOString()));
        await workflow.runDiagnosis(evaluationCase.id);
        await workflow.authorize(evaluationCase.id);
        await workflow.executePending(evaluationCase.id);
      }
    }
    return send(response, 200, JSON.stringify(evaluation));
  }
  send(response, 404, JSON.stringify({ error: 'Not found' }));
}

const port = config.port;
const server = createServer((request, response) => { void handle(request, response).catch((error: unknown) => send(response, 500, JSON.stringify({ error: String(error) }))); });

async function bootstrap(): Promise<void> {
  if (postgresStore) await postgresStore.initialize();
  server.listen(port, () => console.log(`Recovery Loop listening on http://localhost:${port}`));
}

void bootstrap().catch((error: unknown) => {
  console.error('Recovery Loop failed to start', error);
  process.exitCode = 1;
});
