import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DeterministicSimulator, FixedClock } from './provider.js';
import { DeterministicPolicy, FixtureDiagnosisEngine, InMemoryRecoveryStore, RecoveryWorkflow } from './recovery.js';
import { generateEvaluationCases, runEvaluation } from './evaluation.js';

const clock = new FixedClock('2026-01-01T00:00:00.000Z');
const store = new InMemoryRecoveryStore();
const provider = new DeterministicSimulator();
const workflow = new RecoveryWorkflow(store, provider, new FixtureDiagnosisEngine(), new DeterministicPolicy(), clock);
let latestEvaluation: ReturnType<typeof runEvaluation> | undefined;

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

function metrics() {
  const cases = store.all();
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

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/') return send(response, 200, dashboard(), 'text/html');
  if (request.method === 'GET' && url.pathname === '/api/metrics') return send(response, 200, JSON.stringify(metrics()));
  if (request.method === 'GET' && url.pathname === '/api/cases') return send(response, 200, JSON.stringify(store.all().map((recoveryCase) => ({ id: recoveryCase.id, status: recoveryCase.status, amount: recoveryCase.context.amount, actions: recoveryCase.actions.length, audit: recoveryCase.audit.length }))));
  if (request.method === 'POST' && url.pathname === '/api/evaluation') {
    const evaluation = runEvaluation(generateEvaluationCases(60, 42));
    latestEvaluation = evaluation;
    for (const evaluationCase of evaluation.cases) {
      if (!store.get(evaluationCase.id)) {
        workflow.openCase(evaluationCase.id, evaluationCase.context);
        workflow.ingestEvent(provider.normalizeEvent({ id: `${evaluationCase.id}:failed`, type: 'payment_failed', caseId: evaluationCase.id, occurredAt: clock.now().toISOString(), payload: { method: 'recurring_mandate' } }, clock.now().toISOString()));
        workflow.runDiagnosis(evaluationCase.id);
        workflow.authorize(evaluationCase.id);
        workflow.executePending(evaluationCase.id);
      }
    }
    return send(response, 200, JSON.stringify(evaluation));
  }
  send(response, 404, JSON.stringify({ error: 'Not found' }));
}

const port = Number(process.env.PORT ?? 3000);
createServer((request, response) => { void handle(request, response).catch((error: unknown) => send(response, 500, JSON.stringify({ error: String(error) }))); }).listen(port, () => {
  console.log(`Recovery Loop listening on http://localhost:${port}`);
});
