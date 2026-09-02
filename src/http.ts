import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RecoveryApplication } from './application.js';
import type { NormalizedEventInput } from './provider.js';
import { caseStatuses, isTerminal, renewalContextViolation, type CaseStatus, type RecoveryCase, type RenewalContext } from './domain.js';
import { authorizedControlRequest } from './auth.js';
import { RecoveryCaseConflictError } from './recovery.js';
import { WebhookIngress, WebhookRejection } from './webhook.js';
import { fallbackRecoveryMessage } from './messaging.js';
import { publishSeededBatch } from './evaluation.js';
import { LAB_INSTANT, LAB_SCENARIO_KEYS, LabRunner, labScenarios } from './lab.js';

function send(response: ServerResponse, status: number, body: string, contentType = 'application/json'): void {
  response.writeHead(status, { 'content-type': `${contentType}; charset=utf-8`, 'cache-control': 'no-store' });
  response.end(body);
}

function dashboard(): string {
  return `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recovery Loop</title><style>
:root{color-scheme:light;--background:#f8fafc;--surface:#fff;--surface-muted:#f8fafc;--foreground:#0f172a;--muted:#64748b;--subtle:#94a3b8;--border:#e2e8f0;--border-strong:#cbd5e1;--primary:#0f172a;--primary-hover:#1e293b;--primary-foreground:#fff;--primary-muted:#cbd5e1;--ring:#94a3b8;--success:#15803d;--success-bg:#f0fdf4;--warning:#a16207;--warning-bg:#fefce8;--danger:#b91c1c;--danger-bg:#fef2f2;--info:#1d4ed8;--info-bg:#eff6ff}
:root[data-theme="dark"]{color-scheme:dark;--background:#09090b;--surface:#111113;--surface-muted:#18181b;--foreground:#f4f4f5;--muted:#a1a1aa;--subtle:#71717a;--border:#27272a;--border-strong:#3f3f46;--primary:#f4f4f5;--primary-hover:#e4e4e7;--primary-foreground:#18181b;--primary-muted:#64748b;--ring:#71717a;--success:#f0fdf4;--success-bg:#166534;--warning:#facc15;--warning-bg:#422006;--danger:#fef2f2;--danger-bg:#991b1b;--info:#60a5fa;--info-bg:#172554}
*{box-sizing:border-box}body{font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:var(--background);color:var(--foreground)}main{max-width:1440px;margin:auto;padding:40px 32px 72px}h1,h2,h3,h4,p{margin-top:0}h1{font-size:30px;letter-spacing:-.03em;line-height:1.2;margin-bottom:8px}h2{font-size:18px;letter-spacing:-.015em;margin:0}.muted{color:var(--muted)}.eyebrow{color:var(--subtle);font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase}.lede{color:var(--muted);font-size:15px;margin:0}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.app-header{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;border-bottom:1px solid var(--border);padding-bottom:28px}.brand .eyebrow{margin-bottom:9px}.header-actions{display:flex;align-items:center;gap:12px;padding-top:18px}.environment{display:inline-flex;align-items:center;gap:7px;color:var(--muted);font-size:12px;white-space:nowrap}.dot{width:7px;height:7px;border-radius:999px;background:#22c55e;box-shadow:0 0 0 3px #dcfce7}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:1px solid transparent;border-radius:7px;cursor:pointer;font:600 13px/1 Inter,ui-sans-serif,system-ui,sans-serif;padding:9px 13px;transition:background .15s,border-color .15s,box-shadow .15s}.btn:focus-visible,select:focus-visible,.theme-toggle:focus-visible{outline:2px solid var(--ring);outline-offset:2px}.btn-primary{background:var(--primary);color:var(--primary-foreground);box-shadow:0 1px 2px #0f172a1a}.btn-primary:hover{background:var(--primary-hover)}.btn-outline{background:var(--surface);border-color:var(--border-strong);color:var(--foreground)}.btn-outline:hover{background:var(--surface-muted)}.btn-danger{color:var(--danger);border-color:#fecaca}.btn-danger:hover{background:var(--danger-bg)}.button-meta{color:var(--primary-muted);font-size:11px;font-weight:500}:root[data-theme="dark"] .btn-primary .button-meta{color:#334155}.runtime-facts{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:10px}.runtime-facts .fact-label{color:var(--muted);font-size:11px;letter-spacing:.04em;text-transform:uppercase}.runtime-facts span strong{font-size:12px}
.theme-toggle{align-items:center;background:var(--surface);border:1px solid var(--border-strong);border-radius:7px;color:var(--foreground);cursor:pointer;display:inline-flex;font:600 12px/1 Inter,ui-sans-serif,system-ui,sans-serif;gap:7px;padding:9px 11px;transition:background .15s,border-color .15s}.theme-toggle:hover{background:var(--surface-muted)}.theme-icon{font-size:14px;line-height:1}.theme-label{min-width:30px;text-align:left}
.toolbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:22px 0 30px}.toolbar-copy{display:flex;flex-direction:column;gap:4px;min-width:0}.toolbar-copy .muted{font-size:12px;max-width:920px}.select-field{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:12px;font-weight:600;white-space:nowrap}.select-field select{min-width:150px;border:1px solid var(--border-strong);border-radius:7px;background:var(--surface);color:var(--foreground);font:inherit;padding:8px 30px 8px 10px}
.section{margin-top:32px}.section-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:12px}.section-heading p{color:var(--muted);font-size:13px;margin:4px 0 0}.metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}.metric-card{background:var(--surface);border:1px solid var(--border);border-radius:9px;min-height:106px;padding:16px 17px;box-shadow:0 1px 2px #0f172a08}.metric-card .label{color:var(--muted);font-size:12px;line-height:1.35;max-width:18ch}.metric-card .value{font-size:24px;font-weight:700;letter-spacing:-.035em;line-height:1.1;margin-top:12px}.metric-card .detail{color:var(--subtle);font-size:11px;margin-top:8px}.metric-card.primary{border-color:#cbd5e1;background:linear-gradient(180deg,#fff,#f8fafc)}
.card,.panel{background:var(--surface);border:1px solid var(--border);border-radius:9px;box-shadow:0 1px 2px #0f172a08}.table-shell{overflow:auto;border:1px solid var(--border);border-radius:9px;background:var(--surface);box-shadow:0 1px 2px #0f172a08}.table-shell table{border:0;border-radius:0}.table-shell.compact{margin-top:14px}.table-shell.compact table{min-width:780px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--border);font-size:13px;white-space:nowrap}th{background:var(--surface-muted);color:var(--muted);font-size:11px;font-weight:700;letter-spacing:.045em;text-transform:uppercase}tbody tr:last-child td{border-bottom:0}tr.case:hover{background:#f8fafc}tr.case.selected{background:#f1f5f9}td code,code{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:5px;color:#334155;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;padding:3px 6px}.case-link{background:transparent;border:0;color:inherit;cursor:pointer;font:inherit;padding:0}.case-link:focus-visible{outline:2px solid var(--ring);outline-offset:3px}.case-id{font-weight:600}.cell-note{color:var(--subtle);display:block;font-size:11px;margin-top:3px}.count{color:var(--muted);font-variant-numeric:tabular-nums}.empty-cell{color:var(--muted);padding:26px 14px;text-align:center}
.badge{align-items:center;border:1px solid transparent;border-radius:999px;display:inline-flex;font-size:11px;font-weight:600;line-height:1;padding:5px 8px;white-space:nowrap}.badge-neutral{background:#f1f5f9;border-color:#e2e8f0;color:#475569}.badge-success{background:var(--success-bg);border-color:#bbf7d0;color:var(--success)}.badge-warning{background:var(--warning-bg);border-color:#fde68a;color:var(--warning)}.badge-danger{background:var(--danger-bg);border-color:#fecaca;color:var(--danger)}.badge-info{background:var(--info-bg);border-color:#bfdbfe;color:var(--info)}
.panel{padding:20px}.empty-state{color:var(--muted);padding:8px 0}.detail-header{align-items:flex-start;display:flex;justify-content:space-between;gap:16px}.detail-title{align-items:center;display:flex;flex-wrap:wrap;gap:10px;margin-top:7px}.detail-actions{display:flex;gap:8px}.case-facts{border-bottom:1px solid var(--border);display:grid;gap:14px;grid-template-columns:repeat(4,minmax(0,1fr));margin:20px 0;padding-bottom:18px}.fact{display:flex;flex-direction:column;gap:3px;min-width:0}.fact-label,.block-label{color:var(--subtle);font-size:11px;font-weight:700;letter-spacing:.045em;text-transform:uppercase}.fact strong{font-size:13px;overflow:hidden;text-overflow:ellipsis}.detail-columns{display:grid;gap:24px;grid-template-columns:repeat(2,minmax(0,1fr))}.detail-block{min-width:0}.detail-block.full{grid-column:1/-1}.block-heading{align-items:center;display:flex;justify-content:space-between;margin-bottom:9px}.block-heading h3{font-size:14px;margin:0}.detail-block p{font-size:13px}.detail-block ul{list-style:none;margin:0;padding:0}.detail-block li{border-bottom:1px solid var(--border);font-size:13px;padding:9px 0}.detail-block li:last-child{border-bottom:0}.list-item{align-items:flex-start;display:flex;gap:8px}.list-item .item-copy{min-width:0}.list-item .item-copy .muted{font-size:11px}.timeline li{display:flex;flex-wrap:wrap;gap:6px;line-height:1.4}.timeline li code{flex:0 0 auto}.timeline .audit-data{color:var(--subtle);font-size:11px;overflow-wrap:anywhere}.preview{background:var(--surface-muted);border:1px solid var(--border);border-radius:7px;color:#334155;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:7px 0 0;padding:12px;white-space:pre-wrap}
.split-sections{display:grid;gap:32px;grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.split-sections .section{min-width:0}.section-copy{color:var(--muted);font-size:13px;margin:4px 0 0}.scenario{border:1px solid var(--border);border-radius:8px;margin:10px 0;padding:14px}.scenario h3{font-size:13px;margin:0 0 3px}.scenario p{font-size:12px;margin:0 0 4px}.step{background:var(--surface-muted);border-left:3px solid var(--border-strong);border-radius:0 5px 5px 0;margin:8px 0;padding:8px 10px}.step.pass{border-left-color:#22c55e}.step.fail{border-left-color:#ef4444}.step .what{font-size:12px}.step .got{color:var(--muted);font-size:11px;margin-top:3px;overflow-wrap:anywhere}
:root[data-theme="dark"] .metric-card.primary{background:linear-gradient(180deg,#18181b,#111113)}:root[data-theme="dark"] td code,:root[data-theme="dark"] code{background:#1e293b;border-color:#334155;color:#e2e8f0}:root[data-theme="dark"] tr.case:hover{background:#18181b}:root[data-theme="dark"] tr.case.selected{background:#1e293b}:root[data-theme="dark"] .badge-neutral{background:#27272a;border-color:#3f3f46;color:#d4d4d8}:root[data-theme="dark"] .badge-success,:root[data-theme="dark"] .badge-danger{border-color:#fff;color:#fff}:root[data-theme="dark"] .preview{color:#e2e8f0}:root[data-theme="dark"] .btn-danger{border-color:#7f1d1d}
@media (max-width:900px){main{padding:28px 20px 56px}.app-header{flex-direction:column}.header-actions{padding-top:0}.toolbar{align-items:flex-start;flex-direction:column}.case-facts{grid-template-columns:repeat(2,minmax(0,1fr))}.detail-columns,.split-sections{grid-template-columns:1fr}}@media (max-width:560px){main{padding:22px 14px 44px}.header-actions{align-items:flex-start;flex-direction:column}.section-heading{align-items:flex-start;flex-direction:column;gap:8px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.metric-card{min-height:96px;padding:13px}.metric-card .value{font-size:20px}.case-facts{grid-template-columns:1fr}.detail-header{flex-direction:column}.detail-actions{width:100%}.detail-actions .btn{flex:1}}
</style></head>
 <body><main data-shell>
<header class="app-header"><div class="brand"><div class="eyebrow">Revenue operations</div><h1>Recovery Loop</h1><p class="lede">AI-assisted recovery for failed SaaS renewals.</p></div>
<div class="header-actions"><span class="environment" id="runtime"><span class="dot"></span> Reading runtime…</span><button class="theme-toggle" id="theme-toggle" data-theme-toggle type="button" aria-pressed="false" aria-label="Switch to dark mode"><span class="theme-icon" aria-hidden="true">☾</span><span class="theme-label">Dark</span></button></div></header>
<div class="toolbar"><div class="toolbar-copy"><span class="eyebrow">Workspace snapshot</span><span class="muted" id="batch">Loading live figures…</span><div class="runtime-facts" id="runtime-facts"></div></div><label class="select-field"><span>Status</span>
<select id="filter"><option value="">All</option>${caseStatuses.map((status) => `<option value="${status}">${status}</option>`).join('')}</select></label>
 </div>
<section class="section" aria-labelledby="metrics-heading"><div class="section-heading" data-section-heading><div><h2 id="metrics-heading">At a glance</h2><p>Live projection across every stored recovery case.</p></div></div><div class="metrics" data-card="metric-grid" id="cards"></div></section>
<section class="section" aria-labelledby="cases-heading"><div class="section-heading" data-section-heading><div><h2 id="cases-heading">Recovery cases</h2><p>Select a case to inspect its diagnosis, policy decisions, and audit timeline.</p></div></div>
<div class="table-shell" data-table-wrap><table><caption class="sr-only">Recovery cases</caption><thead><tr><th>Case</th><th>Customer</th><th>Status</th><th>Failure</th><th>Amount</th><th>Recovered</th><th>Actions</th><th>Audit</th><th>Updated</th></tr></thead><tbody id="cases"></tbody></table></div></section>
<section class="section" aria-labelledby="detail-heading"><div class="section-heading" data-section-heading><div><h2 id="detail-heading">Case detail</h2><p>Decision context and the append-only audit trail.</p></div></div><div class="panel" id="detail"><div class="empty-state"><span class="badge badge-neutral" data-badge="status">Waiting for a case</span><p style="margin:10px 0 0">Select a row above to open the recovery record.</p></div></div></section>
<div class="split-sections"><section class="section" aria-labelledby="evaluation-heading"><div class="section-heading" data-section-heading><div><h2 id="evaluation-heading">Evaluation run</h2><p>Seeded results compared with the loop's decisions.</p></div></div><div class="panel" id="evaluation"><div class="empty-state">No batch has run yet.</div></div></section>
<section class="section" aria-labelledby="lab-heading"><div class="section-heading" data-section-heading><div><h2 id="lab-heading">Webhook replay lab</h2><p>Signed deliveries through the real webhook boundary, replayed in an isolated sandbox.</p></div></div><div class="row"><button class="btn btn-outline" id="replay">Replay all scenarios</button><span class="muted" id="labnote"></span></div><div class="panel" id="lab" style="margin-top:12px"><div class="empty-state">Not run yet.</div></div></section></div>
</main>
<script>
const money=(minor,currency)=>new Intl.NumberFormat('en-IN',{style:'currency',currency:currency||'INR'}).format(minor/100);
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=v=>String(v??'—').replaceAll('_',' ');
// The dashboard uses small HTML templates for table rows and badges. Every provider value is
// escaped before interpolation; class names and markup are selected from fixed local maps.
const badge=(value,tone='neutral')=>'<span class="badge badge-'+tone+'" data-badge="status">'+esc(label(value))+'</span>';
const statusTone=value=>({recovered:'success',retry_scheduled:'info',fallback_link_available:'info',at_risk:'warning',diagnosed:'warning',escalated:'danger',exhausted:'danger',stopped:'neutral'}[value]||'neutral');
const statusBadge=value=>badge(value,statusTone(value));
let selected=null;
const get=path=>fetch(path).then(r=>r.json());
const themeKey='recovery-loop-theme';
const themeToggle=document.querySelector('#theme-toggle');
const applyTheme=theme=>{
  const dark=theme==='dark';
  document.documentElement.dataset.theme=dark?'dark':'light';
  if(!themeToggle)return;
  themeToggle.setAttribute('aria-pressed',String(dark));
  themeToggle.setAttribute('aria-label',dark?'Switch to light mode':'Switch to dark mode');
  const icon=themeToggle.querySelector('.theme-icon');
  if(icon)icon.textContent=dark?'☀':'☾';
  const text=themeToggle.querySelector('.theme-label');
  if(text)text.textContent=dark?'Light':'Dark';
};
let savedTheme='light';
try{savedTheme=localStorage.getItem(themeKey)==='dark'?'dark':'light'}catch(e){}
applyTheme(savedTheme);
if(themeToggle)themeToggle.onclick=()=>{
  const next=document.documentElement.dataset.theme==='dark'?'light':'dark';
  applyTheme(next);
  try{localStorage.setItem(themeKey,next)}catch(e){}
};

function renderMetrics(m){
  const b=m.batch;
  const tiles=[['Revenue at risk',money(m.revenueAtRisk,'INR'),'Open renewals'],['Recovered',money(m.recoveredAmount,'INR'),'Live recovered revenue'],['Recovery rate',(m.recoveryRate*100).toFixed(1)+'%','Across stored cases'],['Cases',m.totalCases,'Stored recovery cases'],['Escalated',m.escalated,'Needs operator review'],['Exhausted',m.exhausted,'Both recovery rungs spent']];
  // The batch's own scoring is the only thing the live projection cannot know: ground truth.
  if(b)tiles.push(['Batch first-attempt',(b.retryRecoveryRate*100).toFixed(1)+'%','Seeded evaluation'],['Batch fallback',(b.fallbackRecoveryRate*100).toFixed(1)+'%','Seeded evaluation'],['Policy charges refused',b.unsafeActionsPrevented,'Seeded evaluation'],['Recommendations refused',b.recommendationsRefused,'Seeded evaluation'],['Ineligible retries',b.providerIneligibleRetries,'Seeded evaluation'],['Duplicates prevented',b.duplicateActionsPrevented,'Seeded evaluation'],['Diagnosis accuracy',(b.diagnosisAccuracy*100).toFixed(1)+'%','Seeded evaluation']);
  document.querySelector('#cards').innerHTML=tiles.map((t,i)=>'<article class="metric-card'+(i<3?' primary':'')+'" data-card="metric"><div class="label">'+esc(t[0])+'</div><div class="value">'+esc(t[1])+'</div><div class="detail">'+esc(t[2])+'</div></article>').join('');
  document.querySelector('#batch').textContent=b?'Live figures over all stored cases · seeded batch '+b.seed+' published '+m.batchRecordedAt+' (dataset '+b.datasetVersion+', policy '+b.policyVersion+') · every figure synthetic':'Live figures over all stored cases · no batch published yet · every figure synthetic';
}

function renderCases(cases){
  const table=document.querySelector('#cases');
  table.innerHTML=cases.map(c=>'<tr class="case'+(c.id===selected?' selected':'')+'"><td><button type="button" class="case-link" data-id="'+esc(c.id)+'" aria-label="Open recovery case '+esc(c.id)+'"><span class="case-id"><code>'+esc(c.id)+'</code></span></button></td><td>'+esc(c.customerId)+'</td><td>'+statusBadge(c.status)+'</td><td>'+esc(label(c.failureCategory))+'</td><td>'+money(c.amount,c.currency)+'</td><td>'+money(c.recoveredAmount,c.currency)+'</td><td class="count">'+(c.actions||'—')+'</td><td class="count">'+(c.audit||'—')+'</td><td class="muted">'+esc(c.updatedAt)+'</td></tr>').join('')||'<tr><td class="empty-cell" colspan="9">No cases match. Run the evaluation.</td></tr>';
  table.querySelectorAll('button.case-link').forEach(button=>{button.onclick=()=>openCase(button.dataset.id)});
}

function renderDetail(c){
  const d=c.diagnosis;
  document.querySelector('#detail').innerHTML=
    '<div class="detail-header"><div><div class="eyebrow">Recovery case</div><div class="detail-title"><code>'+esc(c.id)+'</code>'+statusBadge(c.status)+'</div></div>'+'</div>'+
    '<div class="case-facts"><div class="fact"><span class="fact-label">Customer</span><strong>'+esc(c.context.customerId)+'</strong></div><div class="fact"><span class="fact-label">Subscription</span><strong>'+esc(c.context.subscriptionId)+'</strong></div><div class="fact"><span class="fact-label">Renewal amount</span><strong>'+money(c.context.amount,c.context.currency)+'</strong></div><div class="fact"><span class="fact-label">Due</span><strong>'+esc(c.context.dueAt)+'</strong></div></div>'+
    '<div class="detail-columns"><section class="detail-block"><div class="block-heading"><h3>Diagnosis</h3>'+(d?badge('confidence '+(d.confidence*100).toFixed(0)+'%','info'):'')+'</div>'+(d?'<p><strong>'+esc(label(d.failureCategory))+'</strong> · recommends '+esc(label(d.recommendedAction))+' · model '+esc(d.modelVersion)+'</p><p>'+esc(d.explanation)+'</p><ul>'+d.evidence.map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul>':'<p class="muted">No diagnosis recorded.</p>')+'</section>'+
    '<section class="detail-block"><div class="block-heading"><h3>Policy decisions</h3></div>'+(c.decisions.length?'<ul>'+c.decisions.map(x=>'<li class="list-item">'+badge(x.allowed?'allowed':'blocked',x.allowed?'success':'danger')+'<div class="item-copy"><strong>'+esc(label(x.action))+'</strong> · '+esc(x.reason)+'<div class="muted">'+esc(x.policyVersion)+' · '+esc(x.decidedAt)+'</div></div></li>').join('')+'</ul>':'<p class="muted">None.</p>')+'</section>'+
    '<section class="detail-block"><div class="block-heading"><h3>Recovery actions</h3></div>'+(c.actions.length?'<ul>'+c.actions.map(a=>'<li class="list-item">'+badge(label(a.kind),a.status==='failed'?'danger':a.status==='succeeded'?'success':'info')+'<div class="item-copy"><strong>'+esc(label(a.status))+'</strong>'+(a.providerReference?' · '+esc(a.providerReference):'')+(a.expiresAt?' · expires '+esc(a.expiresAt):'')+(a.result?' · '+esc(a.result):'')+'</div></li>').join('')+'</ul>':'<p class="muted">None.</p>')+'</section>'+
    '<section class="detail-block"><div class="block-heading"><h3>Payment attempts</h3></div>'+(c.attempts.length?'<ul>'+c.attempts.map(a=>'<li><strong>'+esc(label(a.method))+'</strong> · '+esc(label(a.status))+(a.failureCode?' · '+esc(a.failureCode):'')+'<div class="muted">'+esc(a.occurredAt)+'</div></li>').join('')+'</ul>':'<p class="muted">None.</p>')+'</section>'+
    (c.fallbackMessage?'<section class="detail-block full"><div class="block-heading"><h3>Fallback message preview</h3>'+badge(c.fallbackMessage.expired?'expired':'preview only',c.fallbackMessage.expired?'danger':'neutral')+'</div><p class="muted">No email, SMS, WhatsApp, or voice provider is connected'+(c.fallbackMessage.expired?', and this link has expired':'')+'.</p><p><strong>'+esc(c.fallbackMessage.subject)+'</strong></p><pre class="preview">'+esc(c.fallbackMessage.body)+'</pre></section>':'')+
    '<section class="detail-block full"><div class="block-heading"><h3>Audit timeline</h3><span class="block-label">'+c.audit.length+' entries</span></div><ul class="timeline">'+c.audit.map(e=>'<li><code>'+esc(e.at)+'</code><strong>'+esc(label(e.type))+'</strong><span class="muted">('+esc(e.actor)+')</span><span>'+esc(e.explanation)+'</span>'+(Object.keys(e.data).length?'<span class="audit-data">'+esc(JSON.stringify(e.data))+'</span>':'')+'</li>').join('')+'</ul></section></div>';
}

async function openCase(id){selected=id;const c=await get('/api/cases/'+encodeURIComponent(id));renderDetail(c);renderCases(await get(listUrl()))}
const listUrl=()=>{const status=document.querySelector('#filter').value;return '/api/cases'+(status?'?status='+encodeURIComponent(status):'')};
function renderEvaluation(batch){
  const panel=document.querySelector('#evaluation');
  if(!batch.available){panel.innerHTML='<div class="empty-state">No batch has run yet.</div>';return}
  panel.innerHTML='<p class="muted">'+batch.results.length+' seeded cases · expected safe action and outcome are recorded independently of what the loop predicted.</p>'+
    '<div class="table-shell compact" data-table-wrap><table><thead><tr><th>Case</th><th>Archetype</th><th>Safe action</th><th>Authorized</th><th>Expected outcome</th><th>Outcome</th><th>Recovered</th></tr></thead><tbody>'+
    batch.results.map(r=>'<tr class="case"><td><button type="button" class="case-link" data-id="'+esc(r.caseId)+'" aria-label="Open recovery case '+esc(r.caseId)+'"><code>'+esc(r.caseId)+'</code></button></td><td>'+esc(label(r.archetype))+'</td><td>'+esc(label(r.expected.safeAction))+'</td><td>'+badge(r.firstAuthorizedAction,r.safeActionMatched?'success':'danger')+'</td><td>'+esc(label(r.expected.outcome))+'</td><td>'+badge(r.outcome,r.matchedExpectation?'success':'danger')+'</td><td>'+money(r.recoveredAmount,'INR')+'</td></tr>').join('')+
    '</tbody></table></div>';
  panel.querySelectorAll('button.case-link').forEach(button=>{button.onclick=()=>openCase(button.dataset.id)});
}
// Naming each component separately: one "synthetic" badge could not say whether the payments, the
// diagnosis, or the batch was the synthetic part, and a reader guessed wrong either way.
function renderRuntime(r){
  document.querySelector('#runtime').innerHTML='<span class="dot"></span> '+esc(r.payments)+' · '+esc(r.liveDiagnosis);
  document.querySelector('#runtime-facts').innerHTML=
    [['Payments',r.payments],['Live diagnosis',r.liveDiagnosis],['Seeded evaluation',r.seededEvaluation],['Persistence',r.persistence],['Recurring retry',r.recurringRetry]]
      .map(([k,v])=>'<span><span class="fact-label">'+esc(k)+'</span> <strong>'+esc(v)+'</strong></span>').join('');
}
async function refresh(){const [m,c,b,r]=await Promise.all([get('/api/metrics'),get(listUrl()),get('/api/evaluation'),get('/api/runtime')]);renderMetrics(m);renderCases(c);renderEvaluation(b);renderRuntime(r)}
document.querySelector('#filter').onchange=refresh;

// Each scenario replays inside the server against a throwaway application. The browser never sees
// a signature or a raw body, and nothing it can press writes to the cases listed above.
async function replay(){
  const panel=document.querySelector('#lab');
  const note=document.querySelector('#labnote');
  panel.innerHTML='<span class="muted">Delivering…</span>';
  note.textContent='';
  const scenarios=await get('/api/lab/scenarios');
  if(!Array.isArray(scenarios)){panel.innerHTML='<span class="muted">The replay lab is unavailable on this instance.</span>';return}
  const blocks=[];
  let passed=0,total=0;
  for(const scenario of scenarios){
    const response=await fetch('/api/lab/replay',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario:scenario.key})});
    if(!response.ok){blocks.push('<div class="scenario"><h3>'+esc(scenario.title)+'</h3><p class="muted">Replay unavailable (HTTP '+response.status+').</p></div>');continue}
    const result=await response.json();
    passed+=result.passed;total+=result.total;
    const steps=result.steps.map(step=>'<div class="step '+(step.passed?'pass':'fail')+'"><div class="what"><strong>'+esc(step.label)+'</strong> — '+esc(step.expect)+'</div>'+
      '<div class="got">HTTP '+step.status+' (expected '+step.expectStatus+') · '+esc(JSON.stringify(step.body))+'</div></div>').join('');
    blocks.push('<div class="scenario"><h3>'+esc(result.title)+'</h3><p class="muted">'+esc(result.description)+'</p>'+
      '<p class="muted">Isolated case <code>'+esc(result.caseId)+'</code>'+(result.detail?' · ended '+esc(label(result.detail.status)):' · never opened')+'</p>'+steps+'</div>');
  }
  panel.innerHTML=blocks.join('');
  note.textContent=passed+' of '+total+' deliveries behaved as declared. Replays run in an isolated sandbox and change nothing above.';
}
document.querySelector('#replay').onclick=replay;
refresh();
</script></body></html>`;
}

function readBody(request: IncomingMessage, maximumBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    request.setEncoding('utf8');
    const onData = (chunk: string): void => {
      size += Buffer.byteLength(chunk);
      if (size > maximumBytes) {
        // Reject without destroying the request: the route answers with the status it chose, and
        // destroying the socket here would tear the connection down before that answer arrives.
        request.removeListener('data', onData);
        reject(new Error('Webhook body is too large'));
        return;
      }
      body += chunk;
    };
    request.on('data', onData);
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
  const { clock, config, evaluationRuns, expirySweeper, persistenceMode, provider, runtimeSummary, store, workflow } = application;
  const ingress = new WebhookIngress(provider, store, workflow, clock);
  const lab = new LabRunner();

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
    try {
      const result = await ingress.handle(rawBody, header(request, 'x-razorpay-signature') ?? '', header(request, 'x-razorpay-event-id'));
      return send(response, result.status, JSON.stringify({ accepted: true, duplicate: result.duplicate, caseId: result.recoveryCase.id, status: result.recoveryCase.status }));
    } catch (error) {
      if (error instanceof WebhookRejection) return send(response, error.status, JSON.stringify({ error: error.message }));
      throw error;
    }
  }

  /**
   * Registers the renewal a provider delivery will later name. This is the merchant-data seam: a
   * webhook carries payment facts, never customer, amount, or due date, so a case must exist
   * before its first failure arrives. Re-registering the same renewal is idempotent; registering a
   * different renewal under an identifier already in use is a conflict, not an overwrite.
   */
  async function registerCase(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let body: { id?: unknown; context?: unknown };
    try {
      body = JSON.parse(await readBody(request)) as typeof body;
    } catch (error) {
      return send(response, 400, JSON.stringify({ error: `Invalid registration: ${String(error)}` }));
    }
    const id = typeof body.id === 'string' && body.id.trim() !== '' ? body.id : undefined;
    if (id === undefined) return send(response, 400, JSON.stringify({ error: 'A Recovery Case id is required' }));
    const supplied = typeof body.context === 'object' && body.context !== null && !Array.isArray(body.context) ? body.context as Record<string, unknown> : undefined;
    if (supplied === undefined || typeof supplied.amount !== 'number') return send(response, 400, JSON.stringify({ error: 'A renewal context with a numeric amount is required' }));
    const context: RenewalContext = {
      customerId: String(supplied.customerId ?? ''),
      subscriptionId: String(supplied.subscriptionId ?? ''),
      orderId: String(supplied.orderId ?? ''),
      amount: supplied.amount,
      currency: String(supplied.currency ?? ''),
      dueAt: String(supplied.dueAt ?? ''),
    };
    const violation = renewalContextViolation(context);
    if (violation) return send(response, 400, JSON.stringify({ error: violation }));
    try {
      const opened = await workflow.openCaseWithOutcome(id, context);
      return send(response, opened.registered ? 201 : 200, JSON.stringify({ caseId: opened.recoveryCase.id, status: opened.recoveryCase.status, registered: opened.registered }));
    } catch (error) {
      if (error instanceof RecoveryCaseConflictError) {
        return send(response, 409, JSON.stringify({ error: error.message }));
      }
      throw error;
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
    // The webhook carries a provider HMAC of its own, so it is the one mutation outside the
    // control plane. Everything else that writes is gated before its body is even read.
    if (request.method === 'POST' && url.pathname === '/webhooks/razorpay') return webhook(request, response);
    const operator = /^\/api\/cases\/(?<caseId>[^/]+)\/(?<verdict>stop|escalate)$/.exec(url.pathname);
    const mutation = request.method === 'POST'
      && (operator?.groups !== undefined || url.pathname === '/api/expire' || url.pathname === '/api/evaluation' || url.pathname === '/api/recovery-cases');
    if (mutation) {
      // An instance with no configured token has no control plane at all, so the routes are not
      // merely locked: they do not exist. Saying `401` would advertise what a token would unlock.
      if (config.controlPlaneToken === undefined) return send(response, 404, JSON.stringify({ error: 'Not found' }));
      if (!authorizedControlRequest(request, config.controlPlaneToken)) return send(response, 401, JSON.stringify({ error: 'A control-plane bearer token is required' }));
    }
    if (request.method === 'POST' && url.pathname === '/api/recovery-cases') return registerCase(request, response);
    if (request.method === 'POST' && operator?.groups) {
      return operatorAction(response, caseIdFrom(operator), operator.groups.verdict as 'stop' | 'escalate');
    }
    if (request.method === 'POST' && url.pathname === '/api/expire') {
      // The same bounded sweep the scheduler runs. This route exists for operational verification;
      // it is not what keeps lapsed links from accumulating.
      return send(response, 200, JSON.stringify(await expirySweeper.sweep()));
    }
    if (request.method === 'GET' && url.pathname === '/healthz') {
      try {
        await store.healthCheck();
      } catch (error) {
        // The reason belongs in the logs, not in a public body: a driver error names the host,
        // the database, and often the user it failed to authenticate.
        console.error('Recovery Loop readiness check failed', error);
        return send(response, 503, JSON.stringify({ ok: false, persistence: persistenceMode }));
      }
      return send(response, 200, JSON.stringify({ ok: true, persistence: persistenceMode }));
    }
    if (request.method === 'GET' && url.pathname === '/') return send(response, 200, dashboard(), 'text/html');
    if (request.method === 'GET' && url.pathname === '/api/runtime') return send(response, 200, JSON.stringify(runtimeSummary));
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
    if (request.method === 'GET' && url.pathname === '/api/lab/scenarios') {
      return send(response, 200, JSON.stringify(labScenarios().map(({ key, title, description, steps }) => ({ key, title, description, steps: steps.map(({ label, expect, expectStatus }) => ({ label, expect, expectStatus })) }))));
    }
    if (request.method === 'POST' && url.pathname === '/api/lab/replay') {
      // The lab runs entirely inside this process against a throwaway application, so the button
      // stays public: a visitor can prove the boundary to themselves without a token, and still
      // cannot reach the canonical store, the diagnosis model, or a signature.
      let body: { scenario?: unknown };
      try {
        body = JSON.parse(await readBody(request)) as typeof body;
      } catch (error) {
        return send(response, 400, JSON.stringify({ error: `Invalid lab request: ${String(error)}` }));
      }
      const extra = Object.keys(body).filter((key) => key !== 'scenario');
      if (extra.length > 0) return send(response, 400, JSON.stringify({ error: `Unexpected lab request fields: ${extra.join(', ')}` }));
      if (typeof body.scenario !== 'string' || !LAB_SCENARIO_KEYS.includes(body.scenario)) {
        return send(response, 404, JSON.stringify({ error: `Unknown lab scenario: ${String(body.scenario)}` }));
      }
      const { recoveryCase, ...replayed } = await lab.replay(body.scenario);
      return send(response, 200, JSON.stringify({ ...replayed, detail: recoveryCase === undefined ? null : caseDetail(recoveryCase, LAB_INSTANT) }));
    }
    if (request.method === 'GET' && url.pathname === '/api/evaluation') {
      // The dashboard reloads without re-running the batch, so a refresh — or a restart —
      // cannot change the published figures. Only POST runs one.
      const latestRun = await evaluationRuns.latestRun();
      if (!latestRun) return send(response, 200, JSON.stringify({ available: false }));
      return send(response, 200, JSON.stringify({ available: true, ...latestRun }));
    }
    if (request.method === 'POST' && url.pathname === '/api/evaluation') {
      const run = await publishSeededBatch(store, evaluationRuns, clock.now().toISOString());
      return send(response, 200, JSON.stringify({ available: true, ...run }));
    }
    send(response, 404, JSON.stringify({ error: 'Not found' }));
  }

  return (request, response) => {
    void handle(request, response).catch((error: unknown) => send(response, 500, JSON.stringify({ error: String(error) })));
  };
}
