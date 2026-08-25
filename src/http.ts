import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RecoveryApplication } from './application.js';
import type { NormalizedEventInput } from './provider.js';
import { caseStatuses, isTerminal, terminalStatuses, type CaseStatus, type RecoveryCase } from './domain.js';
import { fallbackRecoveryMessage } from './messaging.js';
import { generateEvaluationCases, runEvaluation, toEvaluationRun } from './evaluation.js';

function send(response: ServerResponse, status: number, body: string, contentType = 'application/json'): void {
  response.writeHead(status, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store' });
  response.end(body);
}

function dashboard(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recovery Loop</title><style>
body{font:16px system-ui;margin:0;background:#f6f7f9;color:#18202a}main{max-width:1180px;margin:auto;padding:32px}h1{margin-top:0}h2{margin:28px 0 8px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}.card{background:white;border:1px solid #dfe3e8;border-radius:10px;padding:16px}
.label{color:#64748b;font-size:13px}.value{font-size:26px;font-weight:700;margin-top:6px}
button{background:#155eef;color:white;border:0;border-radius:6px;padding:9px 12px;cursor:pointer}button.ghost{background:white;color:#b42318;border:1px solid #f0c2bd}
select{padding:8px;border-radius:6px;border:1px solid #cbd5e1;background:white}
table{width:100%;margin-top:12px;background:white;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #e5e7eb;font-size:14px}
tr.case{cursor:pointer}tr.case:hover{background:#f8fafc}tr.case.selected{background:#eef2ff}
code{background:#eef2ff;padding:2px 4px;border-radius:4px}.muted{color:#64748b}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.panel{background:white;border:1px solid #dfe3e8;border-radius:10px;padding:18px;margin-top:12px}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#eef2ff;color:#155eef}.pill.no{background:#fef3f2;color:#b42318}
ul{margin:6px 0;padding-left:20px}li{font-size:14px}.timeline li{margin-bottom:6px}
pre.preview{background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:12px;white-space:pre-wrap;font:14px system-ui;margin:6px 0}
</style></head>
<body><main><h1>Recovery Loop</h1><p class="muted">Synthetic recovery control plane · AI recommends, deterministic policy authorizes.</p>
<div class="row"><button id="run">Run 60-case evaluation</button><label class="muted">Status
<select id="filter"><option value="">All</option>${caseStatuses.map((status) => `<option value="${status}">${status}</option>`).join('')}</select></label>
<span class="muted" id="batch"></span></div>
<section class="cards" id="cards"></section>
<h2>Recovery cases</h2><p class="muted">Select a case to inspect its diagnosis, policy decisions, and audit timeline.</p>
<table><thead><tr><th>Case</th><th>Customer</th><th>Status</th><th>Failure</th><th>Amount</th><th>Recovered</th><th>Actions</th><th>Audit</th><th>Updated</th></tr></thead><tbody id="cases"></tbody></table>
<h2>Case detail</h2><div class="panel" id="detail"><span class="muted">No case selected.</span></div>
<h2>Evaluation run</h2><div class="panel" id="evaluation"><span class="muted">No batch has run yet.</span></div>
</main>
<script>
const TERMINAL=${JSON.stringify([...terminalStatuses])};
const money=(minor,currency)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:currency||'INR'}).format(minor/100);
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let selected=null;
const get=path=>fetch(path).then(r=>r.json());

function renderMetrics(m){
  const b=m.batch;
  const tiles=[['Revenue at risk',money(m.revenueAtRisk,'INR')],['Recovered',money(m.recoveredAmount,'INR')],['Recovery rate',(m.recoveryRate*100).toFixed(1)+'%'],['Cases',m.totalCases],['Escalated',m.escalated],['Exhausted',m.exhausted]];
  // The batch's own scoring is the only thing the live projection cannot know: ground truth.
  if(b)tiles.push(['Batch first-attempt',(b.retryRecoveryRate*100).toFixed(1)+'%'],['Batch fallback',(b.fallbackRecoveryRate*100).toFixed(1)+'%'],['Batch unsafe prevented',b.unsafeActionsPrevented],['Batch duplicates prevented',b.duplicateActionsPrevented],['Batch diagnosis accuracy',(b.diagnosisAccuracy*100).toFixed(1)+'%']);
  document.querySelector('#cards').innerHTML=tiles.map(t=>'<div class="card"><div class="label">'+t[0]+'</div><div class="value">'+esc(t[1])+'</div></div>').join('');
  document.querySelector('#batch').textContent=b?'Live figures over all stored cases · seeded batch '+b.seed+' published '+m.batchRecordedAt+' (dataset '+b.datasetVersion+', policy '+b.policyVersion+') · every figure synthetic':'Live figures over all stored cases · no batch published yet · every figure synthetic';
}

function renderCases(cases){
  document.querySelector('#cases').innerHTML=cases.map(c=>'<tr class="case'+(c.id===selected?' selected':'')+'" data-id="'+esc(c.id)+'"><td><code>'+esc(c.id)+'</code></td><td>'+esc(c.customerId)+'</td><td>'+esc(c.status)+'</td><td>'+esc(c.failureCategory??'—')+'</td><td>'+money(c.amount,c.currency)+'</td><td>'+money(c.recoveredAmount,c.currency)+'</td><td>'+c.actions+'</td><td>'+c.audit+'</td><td class="muted">'+esc(c.updatedAt)+'</td></tr>').join('')||'<tr><td colspan="9">No cases match. Run the evaluation.</td></tr>';
  document.querySelectorAll('tr.case').forEach(row=>{row.onclick=()=>openCase(row.dataset.id)});
}

function renderDetail(c){
  const d=c.diagnosis;
  const terminal=TERMINAL.includes(c.status);
  document.querySelector('#detail').innerHTML=
    '<div class="row"><h3 style="margin:0"><code>'+esc(c.id)+'</code></h3><span class="pill">'+esc(c.status)+'</span>'+
    (terminal?'':'<button class="ghost" id="stop">Stop</button><button class="ghost" id="escalate">Escalate</button>')+'</div>'+
    '<p class="muted">'+esc(c.context.customerId)+' · '+esc(c.context.subscriptionId)+' · '+esc(c.context.orderId)+' · '+money(c.context.amount,c.context.currency)+' due '+esc(c.context.dueAt)+' · recovered '+money(c.recoveredAmount,c.context.currency)+'</p>'+
    '<h4>Diagnosis</h4>'+(d?'<p>'+esc(d.failureCategory)+' · confidence '+(d.confidence*100).toFixed(0)+'% · recommends '+esc(d.recommendedAction)+' · model '+esc(d.modelVersion)+'</p><p>'+esc(d.explanation)+'</p><ul>'+d.evidence.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul>':'<p class="muted">No diagnosis recorded.</p>')+
    '<h4>Policy decisions</h4>'+(c.decisions.length?'<ul>'+c.decisions.map(x=>'<li><span class="pill'+(x.allowed?'':' no')+'">'+(x.allowed?'allowed':'blocked')+'</span> '+esc(x.action)+' — '+esc(x.reason)+' <span class="muted">('+esc(x.policyVersion)+' at '+esc(x.decidedAt)+')</span></li>').join('')+'</ul>':'<p class="muted">None.</p>')+
    '<h4>Recovery actions</h4>'+(c.actions.length?'<ul>'+c.actions.map(a=>'<li>'+esc(a.kind)+' · '+esc(a.status)+(a.providerReference?' · '+esc(a.providerReference):'')+(a.expiresAt?' · expires '+esc(a.expiresAt):'')+(a.result?' · '+esc(a.result):'')+'</li>').join('')+'</ul>':'<p class="muted">None.</p>')+
    (c.fallbackMessage?'<h4>Fallback message preview</h4><p class="muted">Preview only — the MVP integrates no email, SMS, WhatsApp, or voice provider'+(c.fallbackMessage.expired?', and this link has expired':'')+'.</p><p><strong>'+esc(c.fallbackMessage.subject)+'</strong></p><pre class="preview">'+esc(c.fallbackMessage.body)+'</pre>':'')+
    '<h4>Payment attempts</h4>'+(c.attempts.length?'<ul>'+c.attempts.map(a=>'<li>'+esc(a.method)+' · '+esc(a.status)+(a.failureCode?' · '+esc(a.failureCode):'')+' · '+esc(a.occurredAt)+'</li>').join('')+'</ul>':'<p class="muted">None.</p>')+
    '<h4>Audit timeline</h4><ul class="timeline">'+c.audit.map(e=>'<li><code>'+esc(e.at)+'</code> <strong>'+esc(e.type)+'</strong> <span class="muted">('+esc(e.actor)+')</span> — '+esc(e.explanation)+(Object.keys(e.data).length?' <span class="muted">'+esc(JSON.stringify(e.data))+'</span>':'')+'</li>').join('')+'</ul>';
  const applyVerdict=async suffix=>{await fetch('/api/cases/'+encodeURIComponent(c.id)+suffix,{method:'POST'});await refresh();await openCase(c.id)};
  const stop=document.querySelector('#stop');if(stop)stop.onclick=()=>applyVerdict('/stop');
  const escalate=document.querySelector('#escalate');if(escalate)escalate.onclick=()=>applyVerdict('/escalate');
}

async function openCase(id){selected=id;const c=await get('/api/cases/'+encodeURIComponent(id));renderDetail(c);renderCases(await get(listUrl()))}
const listUrl=()=>{const status=document.querySelector('#filter').value;return '/api/cases'+(status?'?status='+encodeURIComponent(status):'')};
function renderEvaluation(batch){
  const panel=document.querySelector('#evaluation');
  if(!batch.available){panel.innerHTML='<span class="muted">No batch has run yet.</span>';return}
  panel.innerHTML='<p class="muted">'+batch.results.length+' seeded cases · expected safe action and outcome are recorded independently of what the loop predicted.</p>'+
    '<table><thead><tr><th>Case</th><th>Archetype</th><th>Safe action</th><th>Authorized</th><th>Expected outcome</th><th>Outcome</th><th>Recovered</th></tr></thead><tbody>'+
    batch.results.map(r=>'<tr class="case" data-id="'+esc(r.caseId)+'"><td><code>'+esc(r.caseId)+'</code></td><td>'+esc(r.archetype)+'</td><td>'+esc(r.expected.safeAction)+'</td><td><span class="pill'+(r.safeActionMatched?'':' no')+'">'+esc(r.firstAuthorizedAction)+'</span></td><td>'+esc(r.expected.outcome)+'</td><td><span class="pill'+(r.matchedExpectation?'':' no')+'">'+esc(r.outcome)+'</span></td><td>'+money(r.recoveredAmount,'INR')+'</td></tr>').join('')+
    '</tbody></table>';
  panel.querySelectorAll('tr.case').forEach(row=>{row.onclick=()=>openCase(row.dataset.id)});
}
async function refresh(){const [m,c,b]=await Promise.all([get('/api/metrics'),get(listUrl()),get('/api/evaluation')]);renderMetrics(m);renderCases(c);renderEvaluation(b)}
document.querySelector('#filter').onchange=refresh;
document.querySelector('#run').onclick=async()=>{await fetch('/api/evaluation',{method:'POST'});await refresh()};
refresh();
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

/** Reads the case id a `/api/cases/:id` route matched, undoing the path encoding once. */
function caseIdFrom(match: RegExpExecArray): string {
  return decodeURIComponent(match.groups?.caseId ?? '');
}

/** The case-list row: enough to filter the list and choose a case to open. */
function caseSummary(recoveryCase: RecoveryCase) {
  return {
    id: recoveryCase.id,
    status: recoveryCase.status,
    outcome: recoveryCase.outcome ?? null,
    customerId: recoveryCase.context.customerId,
    subscriptionId: recoveryCase.context.subscriptionId,
    amount: recoveryCase.context.amount,
    currency: recoveryCase.context.currency,
    recoveredAmount: recoveryCase.recoveredAmount,
    failureCategory: recoveryCase.diagnosis?.failureCategory ?? null,
    actions: recoveryCase.actions.length,
    audit: recoveryCase.audit.length,
    updatedAt: recoveryCase.updatedAt,
  };
}

/**
 * The whole case, in the order an operator reads it: what the renewal was, what the model
 * thought and why, what policy authorized or blocked, what was executed, and the append-only
 * timeline behind all of it. The aggregate is already the audit record, so this projects it
 * rather than summarizing it — nothing an operator would need to explain a decision is dropped.
 */
function caseDetail(recoveryCase: RecoveryCase, now: string) {
  return {
    id: recoveryCase.id,
    status: recoveryCase.status,
    outcome: recoveryCase.outcome ?? null,
    context: recoveryCase.context,
    recoveredAmount: recoveryCase.recoveredAmount,
    createdAt: recoveryCase.createdAt,
    updatedAt: recoveryCase.updatedAt,
    diagnosis: recoveryCase.diagnosis ?? null,
    decisions: recoveryCase.decisions,
    actions: recoveryCase.actions,
    attempts: recoveryCase.attempts,
    events: recoveryCase.events.map(({ id, type, providerPaymentId, occurredAt, receivedAt }) => ({ id, type, providerPaymentId: providerPaymentId ?? null, occurredAt, receivedAt })),
    audit: recoveryCase.audit,
    fallbackMessage: fallbackRecoveryMessage(recoveryCase, now) ?? null,
  };
}

export type CaseSummary = ReturnType<typeof caseSummary>;
export type CaseDetail = ReturnType<typeof caseDetail>;

/**
 * The HTTP boundary. Every webhook is verified, parsed, and persisted here before any
 * orchestration runs, so an unsigned or unparseable delivery can never reach the workflow.
 */
export function createRequestListener(application: RecoveryApplication): (request: IncomingMessage, response: ServerResponse) => void {
  const { clock, evaluationRuns, provider, store, workflow } = application;

  /**
   * The live projection over stored cases, always — a published batch reports beside it rather
   * than replacing it, because runs are durable and a batch that shadowed the live figures would
   * do so permanently. The batch drove its cases through this same loop, so it is already part of
   * the live totals; `batch` adds what only a seeded run can know: its ground-truth scoring.
   */
  async function metrics() {
    const cases = await store.all();
    const publishedRun = await evaluationRuns.latestRun();
    return {
      totalCases: cases.length,
      // Revenue at Risk is the value of renewals still in play: a case that reached any terminal
      // outcome — recovered, escalated, exhausted, stopped — is resolved and stops counting.
      revenueAtRisk: cases.reduce((sum, recoveryCase) => sum + (isTerminal(recoveryCase.status) ? 0 : recoveryCase.context.amount), 0),
      recoveredAmount: cases.reduce((sum, recoveryCase) => sum + recoveryCase.recoveredAmount, 0),
      recoveryRate: cases.length === 0 ? 0 : cases.filter((recoveryCase) => recoveryCase.status === 'recovered').length / cases.length,
      escalated: cases.filter((recoveryCase) => recoveryCase.status === 'escalated').length,
      exhausted: cases.filter((recoveryCase) => recoveryCase.status === 'exhausted').length,
      // Every figure this MVP publishes comes from synthetic data, live projection included.
      synthetic: true,
      batch: publishedRun?.metrics ?? null,
      batchRecordedAt: publishedRun?.recordedAt ?? null,
    };
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
      return operatorAction(response, caseIdFrom(operator), operator.groups.verdict as 'stop' | 'escalate');
    }
    if (request.method === 'POST' && url.pathname === '/api/expire') {
      // Nothing else retires a lapsed fallback link, so the sweep is the loop's closing step.
      const swept = await Promise.all((await store.all()).map((recoveryCase) => workflow.expireLapsedFallbackLink(recoveryCase.id)));
      return send(response, 200, JSON.stringify({ expired: swept.filter((recoveryCase) => recoveryCase.status === 'exhausted').map((recoveryCase) => recoveryCase.id) }));
    }
    if (request.method === 'GET' && url.pathname === '/') return send(response, 200, dashboard(), 'text/html');
    if (request.method === 'GET' && url.pathname === '/api/metrics') return send(response, 200, JSON.stringify(await metrics()));
    if (request.method === 'GET' && url.pathname === '/api/cases') {
      const status = url.searchParams.get('status');
      // A filter no status can satisfy is a caller mistake, not an empty result set.
      if (status !== null && !caseStatuses.includes(status as CaseStatus)) return send(response, 400, JSON.stringify({ error: `Unknown case status: ${status}` }));
      const cases = await store.all();
      return send(response, 200, JSON.stringify(cases.filter((recoveryCase) => status === null || recoveryCase.status === status).map(caseSummary)));
    }
    const detail = /^\/api\/cases\/(?<caseId>[^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && detail?.groups) {
      const caseId = caseIdFrom(detail);
      const recoveryCase = await store.get(caseId);
      if (!recoveryCase) return send(response, 404, JSON.stringify({ error: `Recovery Case not found: ${caseId}` }));
      return send(response, 200, JSON.stringify(caseDetail(recoveryCase, clock.now().toISOString())));
    }
    if (request.method === 'GET' && url.pathname === '/api/evaluation') {
      // The dashboard reloads without re-running the batch, so a refresh — or a restart —
      // cannot change the published figures. Only POST runs one.
      const latestRun = await evaluationRuns.latestRun();
      if (!latestRun) return send(response, 200, JSON.stringify({ available: false }));
      return send(response, 200, JSON.stringify({ available: true, ...latestRun }));
    }
    if (request.method === 'POST' && url.pathname === '/api/evaluation') {
      const evaluation = await runEvaluation(generateEvaluationCases(60, 42));
      const run = toEvaluationRun(evaluation, clock.now().toISOString());
      await evaluationRuns.saveRun(run);
      // The batch already drove real Recovery Cases, so the dashboard shows those rather than
      // re-running a second, differently-shaped loop for display.
      for (const result of evaluation.results) await store.save(result.recoveryCase);
      return send(response, 200, JSON.stringify({ available: true, ...run }));
    }
    send(response, 404, JSON.stringify({ error: 'Not found' }));
  }

  return (request, response) => {
    void handle(request, response).catch((error: unknown) => send(response, 500, JSON.stringify({ error: String(error) })));
  };
}
