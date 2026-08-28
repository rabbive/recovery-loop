# Hackathon Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Recovery Loop so concurrent requests cannot duplicate money actions, recovered revenue is explicitly attributable, the public demo is safe and durable, and all public claims are verifiable.

**Architecture:** The existing single-process TypeScript application gains a store-owned per-case lock used by every workflow mutation, explicit provider-action correlation on success, and a credential-free isolated replay lab. Heroku uses PostgreSQL with a bounded in-process expiry scheduler; canonical mutations require either a provider HMAC or a controller bearer token, while Razorpay recurring retry stays disabled until a real Test Mode proof is recorded.

**Tech Stack:** TypeScript 5.7, Node.js 22, Vitest 2, PostgreSQL 16/`pg`, Node `http` and `crypto`, Heroku Common Runtime.

**Spec:** `docs/superpowers/specs/2026-08-28-hackathon-readiness-design.md`

## Global Constraints

- Keep one deployable TypeScript application; do not add a queue, second service, frontend framework, ORM, or migration framework.
- Implement one numbered task at a time with a Luna worker; a Sol lead reviews the diff and test evidence before the next task starts.
- The diagnosis model remains advisory and has no provider credentials; deterministic policy remains the only action authorizer.
- Every case permits at most one `retry` and one `fallback_link`, and no action may alter customer, subscription, order, amount, or currency.
- The public lab uses simulator payments and deterministic fixture diagnosis only; it never writes the canonical store or calls Pincc, Anthropic, or Razorpay.
- The seeded evaluation always uses simulator payments and deterministic fixture diagnosis and labels every figure synthetic.
- Razorpay API credentials and `RAZORPAY_WEBHOOK_SECRET` are separate; neither may substitute for the other.
- `RAZORPAY_RECURRING_RETRY_ENABLED` defaults to `false`; the proven Razorpay Test Mode payment-link path remains enabled.
- The public Heroku deployment sets `REQUIRE_DATABASE=true`; local tests and the isolated lab may use memory.
- One expiry tick processes at most 100 cases and runs at most once every 60 seconds.
- Do not provision a paid database, change repository visibility, close issue #1, or deploy until the explicit controller gates in Task 8.
- Do not create or invent a video URL. README wording is exactly: `**Demo video:** Recording deferred; no video URL is published yet.`
- Preserve unrelated worktree changes. In particular, do not stage the pre-existing `package-lock.json` modification unless a reviewed task intentionally changes dependencies and regenerates it.

---

### Task 1: Atomic Per-Case Workflow Coordination

**Files:**

- Modify: `src/recovery.ts`
- Modify: `src/persistence.ts`
- Modify: `src/persistence.sql`
- Modify: `tests/orchestration.test.ts`
- Modify: `tests/persistence.test.ts`
- Create: `tests/postgres-concurrency.test.ts`

**Interfaces:**

- Produces: `RecoveryCaseTransaction` with `get(): Promise<RecoveryCase | undefined>` and `save(recoveryCase: RecoveryCase): Promise<void>`.
- Produces: `RecoveryStore.withCaseLock<T>(caseId: string, operation: (transaction: RecoveryCaseTransaction) => Promise<T>): Promise<T>`.
- Produces: `RecoveryStore.findLapsedFallbackCaseIds(now: string, limit: number): Promise<string[]>` and `healthCheck(): Promise<void>` as safe stubs for Tasks 5 and 6.
- Produces: `RecoveryWorkflow.ingestAndDrive(event: ProviderEvent, initialContext?: RenewalContext): Promise<{ recoveryCase: RecoveryCase; duplicate: boolean }>`.
- Preserves: existing public `openCase`, `ingestEvent`, `drive`, `runDiagnosis`, `authorize`, `executePending`, `stop`, `escalate`, and `expireLapsedFallbackLink` behavior, but each public mutation must enter `withCaseLock` once and delegate to private transaction-aware helpers.

- [ ] **Step 1: Add a failing in-memory concurrency test**

Add a provider double to `tests/orchestration.test.ts` that pauses the first retry until both drives have been started:

```ts
class GatedProvider extends DeterministicSimulator {
  callsStarted = 0;
  private release!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.release = resolve; });

  override async submitRetry(recoveryCase: RecoveryCase, action: RecoveryAction) {
    this.callsStarted += 1;
    if (this.callsStarted === 1) await this.gate;
    return super.submitRetry(recoveryCase, action);
  }

  openGate(): void { this.release(); }
}
```

Open and ingest one failed mandate case, then start two `workflow.drive('case-1')` calls without awaiting either. Wait one microtask, open the gate, await both, and assert:

```ts
expect(provider.callsStarted).toBe(1);
expect(provider.calls.map((action) => action.idempotencyKey)).toEqual(['case-1:retry']);
expect((await store.get('case-1'))?.actions).toHaveLength(1);
expect((await store.get('case-1'))?.decisions.filter((decision) => decision.allowed)).toHaveLength(1);
```

- [ ] **Step 2: Run the focused test and confirm the race is reproduced**

Run: `npm test -- tests/orchestration.test.ts -t "serializes concurrent drives"`

Expected: FAIL because both requests can load the same unlocked state; `callsStarted` is `2`, or the final case loses one concurrent write.

- [ ] **Step 3: Add the store transaction contract and memory lock**

In `src/recovery.ts`, add the exact interfaces above. Implement `InMemoryRecoveryStore.withCaseLock` with a per-id promise tail and `finally` cleanup. The operation's transaction reads and writes the map directly; do not call `withCaseLock` recursively. Implement the future interfaces now:

```ts
async findLapsedFallbackCaseIds(now: string, limit: number): Promise<string[]> {
  return [...this.cases.values()]
    .filter((candidate) => !isTerminal(candidate.status) && fallbackLinkState(candidate, now)?.live === false)
    .sort((left, right) => {
      const leftExpiry = fallbackLinkState(left, now)?.action.expiresAt ?? '';
      const rightExpiry = fallbackLinkState(right, now)?.action.expiresAt ?? '';
      return leftExpiry.localeCompare(rightExpiry) || left.id.localeCompare(right.id);
    })
    .slice(0, limit)
    .map((candidate) => candidate.id);
}

async healthCheck(): Promise<void> {}
```

Refactor workflow methods into lock-taking public wrappers and private helpers that accept `RecoveryCaseTransaction`. `ingestAndDrive` must perform missing-case creation, event deduplication, ingestion, diagnosis, authorization, provider execution, and final save inside one callback. The callback returns `{ recoveryCase, duplicate }`; a duplicate does not diagnose or execute.

- [ ] **Step 4: Run the in-memory concurrency and orchestration tests**

Run: `npm test -- tests/orchestration.test.ts tests/workflow.test.ts tests/ordering.test.ts`

Expected: PASS, including exactly one call for concurrent drives and all existing workflow behavior.

- [ ] **Step 5: Add a failing cross-pool PostgreSQL concurrency test**

In `tests/postgres-concurrency.test.ts`, skip unless `TEST_DATABASE_URL` exists. Create two independent `PostgresRecoveryStore` instances, initialize and truncate the schema, and construct two workflows that share a gated provider but use different store instances. Seed the failed case, start `first.drive(caseId)` and `second.drive(caseId)` concurrently, release the provider gate, and assert one provider call, one action row, one allowed decision, and one coherent JSON `state` document.

Also add to `tests/persistence.test.ts`:

```ts
expect(await store!.findLapsedFallbackCaseIds('2026-01-03T00:00:00.000Z', 100))
  .toContain('case-1');
await expect(store!.healthCheck()).resolves.toBeUndefined();
```

- [ ] **Step 6: Run the PostgreSQL test and confirm it fails before locking**

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npm test -- tests/postgres-concurrency.test.ts tests/persistence.test.ts`

Expected: FAIL in the concurrent test because separate pools do not share the in-memory lock and PostgreSQL has no per-case lock yet.

- [ ] **Step 7: Implement the PostgreSQL advisory-lock transaction**

In `PostgresRecoveryStore.withCaseLock`:

1. check out one client;
2. `begin`;
3. execute `select pg_advisory_xact_lock(hashtextextended($1, 0))` with the case id;
4. give the callback a transaction whose `get` uses that client and whose `save` calls a private `saveWithClient(client, recoveryCase)` containing the existing projection writes;
5. commit on success, roll back on error, release in `finally`.

Make public `save` call `withCaseLock(recoveryCase.id, transaction => transaction.save(recoveryCase))`. Implement:

```sql
select ra.case_id
from recovery_actions ra
join recovery_cases rc on rc.id = ra.case_id
where ra.kind = 'fallback_link'
  and ra.status <> 'failed'
  and ra.expires_at <= $1
  and rc.status not in ('recovered', 'escalated', 'exhausted', 'stopped')
group by ra.case_id
order by min(ra.expires_at), ra.case_id
limit $2
```

`healthCheck` executes `select 1`. No schema migration is needed for the advisory lock.

- [ ] **Step 8: Run both store implementations and the full typecheck**

Run: `npm test -- tests/orchestration.test.ts tests/workflow.test.ts tests/ordering.test.ts`

Expected: PASS.

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npm test -- tests/postgres-concurrency.test.ts tests/persistence.test.ts`

Expected: PASS with the PostgreSQL tests not skipped.

Run: `npm run typecheck`

Expected: PASS with no TypeScript errors.

- [ ] **Step 9: Commit and stop for Sol review**

```bash
git add src/recovery.ts src/persistence.ts src/persistence.sql tests/orchestration.test.ts tests/persistence.test.ts tests/postgres-concurrency.test.ts
git commit -m "fix: serialize recovery case mutations"
```

Review gate: the reviewer must see the two-drive race fail before the implementation and pass against both memory and two independent PostgreSQL pools.

---

### Task 2: Explicit Success-to-Action Attribution

**Files:**

- Modify: `src/domain.ts`
- Modify: `src/provider.ts`
- Modify: `src/recovery.ts`
- Modify: `src/evaluation.ts`
- Modify: `tests/workflow.test.ts`
- Modify: `tests/ordering.test.ts`
- Modify: `tests/evaluation.test.ts`
- Modify: `tests/razorpay-adapter.test.ts`
- Modify: `tests/http.test.ts`

**Interfaces:**

- Produces: optional `ProviderEvent.providerActionReference?: string` and `ProviderEvent.actionIdempotencyKey?: string`.
- Produces: `RecoveryAttribution` exactly as declared in the design spec.
- Produces: optional `RecoveryCase.recoveryAttribution?: RecoveryAttribution`.
- Produces: `matchRecoveryAction(recoveryCase: RecoveryCase, event: ProviderEvent): RecoveryAction | undefined` as an exported pure domain helper.
- Changes: `markRecovered(recoveryCase: RecoveryCase, attribution: RecoveryAttribution, now: string): RecoveryCase` requires attribution.
- Changes: `recoveryPathOf` in evaluation reads `recoveryCase.recoveryAttribution?.actionKind`.

- [ ] **Step 1: Write the failing correlation matrix**

Add table-driven workflow tests for these exact cases:

| Case | Success evidence | Expected result |
| --- | --- | --- |
| approved retry | payment id equals retry `providerReference`, event after action | `recovered`, attribution names retry |
| unrelated payment | different payment id and no action key | no recovered amount; active case `stopped` |
| stale payment | correct reference but event before action creation | no recovered amount |
| fallback payment | `providerActionReference` equals link id | `recovered`, attribution names fallback link |
| late after escalation | correct retry reference and later time | `recovered` |
| late after exhaustion | correct expired-link reference and later time | `recovered` |
| terminal unrelated | wrong reference after exhaustion | remains `exhausted`, audit contains `uncorrelated_success` |

Each positive assertion includes:

```ts
expect(result.recoveryAttribution).toMatchObject({
  actionId: expect.any(String),
  idempotencyKey: 'case-1:retry',
  providerReference: 'sim_retry_case-1',
  providerPaymentId: 'sim_retry_case-1',
  eventId: 'event-success',
});
```

- [ ] **Step 2: Run the focused correlation tests**

Run: `npm test -- tests/workflow.test.ts tests/ordering.test.ts -t "correlat|unrelated|late"`

Expected: FAIL because current code recovers whenever any money action exists, regardless of payment id or time.

- [ ] **Step 3: Add the domain types and pure matcher**

Add `RecoveryAttribution`, the event fields, and `recoveryAttribution` to `src/domain.ts`. Add `uncorrelated_success` to `AuditEventType`. Implement `matchRecoveryAction` to require:

```ts
const referenceMatches = event.providerPaymentId === action.providerReference
  || event.providerActionReference === action.providerReference
  || event.actionIdempotencyKey === action.idempotencyKey;
const allowed = recoveryCase.decisions.some((decision) =>
  decision.allowed
  && decision.action === action.kind
  && Date.parse(decision.decidedAt) <= Date.parse(action.createdAt));
const timeMatches = Date.parse(event.occurredAt) >= Date.parse(action.createdAt);
```

Only `retry` and `fallback_link` actions with a non-empty provider reference and events with a non-empty provider payment id are candidates. `markRecovered` persists all attribution fields and the original amount.

- [ ] **Step 4: Normalize and emit provider correlation references**

In `RazorpayTestModeProvider`, add `{ caseId, recoveryActionKey: action.idempotencyKey }` to order and payment-link notes. Extend `NormalizedEventInput` and both providers' `normalizeEvent` methods with the optional correlation fields.

In `webhookInput`, extract through guarded object reads:

```ts
const objectValue = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
const paymentLink = objectValue(objectValue(nestedPayload.payment_link).entity);
const paymentLinkNotes = objectValue(paymentLink.notes);
const providerActionReference = stringValue(payload.providerActionReference)
  ?? stringValue(entity.payment_link_id)
  ?? stringValue(paymentLink.id);
const actionIdempotencyKey = stringValue(payload.actionIdempotencyKey)
  ?? stringValue(notes.recoveryActionKey)
  ?? stringValue(paymentLinkNotes.recoveryActionKey);
```

Use guarded object/string reads, not unchecked optional access on `unknown`.

- [ ] **Step 5: Apply the matcher in the locked ingest path**

For `payment_succeeded`, call `matchRecoveryAction`. A match creates `RecoveryAttribution` and may recover an escalated or exhausted case. An unmatched active case follows the existing stand-down path. An unmatched terminal case appends `uncorrelated_success` and retains its existing status/outcome. Do not infer causation from action count or action status.

- [ ] **Step 6: Make the seeded evaluation explicitly correlated**

Change evaluation success steps to carry the exact retry payment id, fallback link id, or action key for the action intended to settle. Change `late_success_after_exhaustion_recovered` so the fallback link is created successfully, the clock advances beyond its expiry, the existing explicit expiry operation exhausts the case, and a later success names `sim_link_${caseId}`. Remove `recovered_unattributed` from `EvaluationOutcome` and `unattributedRecoveredCases` from `EvaluationMetrics`; every recovered case now has an attribution.

Update evaluation reconciliation assertions to require:

```ts
if (result.recoveredAmount > 0) {
  expect(result.recoveryCase.recoveryAttribution).toBeDefined();
  expect(result.recoveryPath).toBe(result.recoveryCase.recoveryAttribution?.actionKind);
}
```

Run the batch once to measure the new deterministic seed-42 totals. Replace all pinned totals in `tests/evaluation.test.ts` with that observed single run; do not guess or preserve the old unattributed bucket.

- [ ] **Step 7: Run attribution, provider, HTTP, and evaluation tests**

Run: `npm test -- tests/workflow.test.ts tests/ordering.test.ts tests/razorpay-adapter.test.ts tests/http.test.ts tests/evaluation.test.ts`

Expected: PASS. Every recovered evaluation case has `recoveryAttribution`; wrong-reference and pre-action successes add zero recovered revenue.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit and stop for Sol review**

```bash
git add src/domain.ts src/provider.ts src/recovery.ts src/evaluation.ts tests/workflow.test.ts tests/ordering.test.ts tests/evaluation.test.ts tests/razorpay-adapter.test.ts tests/http.test.ts
git commit -m "fix: require explicit recovery attribution"
```

Review gate: the reviewer must trace one retry success, one fallback success, one unrelated success, and one success after exhaustion from provider fields through the persisted attribution and metrics.

---

### Task 3: Protected Canonical Ingress and Isolated Replay Lab

**Files:**

- Create: `src/auth.ts`
- Create: `src/webhook.ts`
- Modify: `src/config.ts`
- Modify: `src/application.ts`
- Modify: `src/provider.ts`
- Modify: `src/http.ts`
- Modify: `src/lab.ts`
- Modify: `.env.example`
- Modify: `tests/application.test.ts`
- Modify: `tests/provider-contract.test.ts`
- Modify: `tests/http.test.ts`
- Modify: `tests/lab.test.ts`

**Interfaces:**

- Produces: `RuntimeConfig.controlPlaneToken?: string` and `simulatorWebhookSecret?: string`.
- Produces: `authorizedControlRequest(request: IncomingMessage, token: string | undefined): boolean` using SHA-256 digest comparison and `timingSafeEqual`.
- Produces: `WebhookIngress.handle(rawBody: string, signature: string, fallbackEventId?: string): Promise<WebhookIngressResult>`.
- Produces: `WebhookIngressResult = { status: 200 | 202; duplicate: boolean; recoveryCase: RecoveryCase }`.
- Produces: `LabRunner.replay(scenario: LabScenario['key']): Promise<LabReplayResult>`.
- Removes: `PaymentProvider.signEvent`, `POST /api/lab/sign`, caller-selected lab run ids, and the `sim:<raw>` signature format.
- Adds: bearer-protected `POST /api/recovery-cases` with `{ id: string; context: RenewalContext }`.

- [ ] **Step 1: Write failing public-boundary tests**

Add tests proving:

1. `DeterministicSimulator` accepts `createHmac('sha256', secret).update(raw).digest('hex')` and rejects `sim:${raw}`.
2. `/api/lab/sign` is `404`.
3. `POST /api/lab/replay` accepts only the four scenario keys and returns no `signature` or `rawBody` field.
4. Replaying every lab scenario leaves canonical `/api/cases` and `/api/metrics` unchanged.
5. A replay with Pincc configured uses a stub that would throw if called, and still passes, proving fixture diagnosis.
6. `POST /api/evaluation`, stop, escalate, expire, and recovery-case registration return `404` with no configured token, `401` with a wrong bearer token, and their normal response with the right token.
7. `POST /api/recovery-cases` returns `201`, a second identical registration returns `200`, and conflicting context returns `409`.
8. A signed initial failure with `payload.payment.entity.notes.caseId` drives the pre-registered case; a signed failure carrying untrusted `context` cannot open a canonical case.

- [ ] **Step 2: Run the focused tests and verify exposure**

Run: `npm test -- tests/provider-contract.test.ts tests/http.test.ts tests/lab.test.ts`

Expected: FAIL because the simulator accepts `sim:<raw>`, the lab exposes signatures, canonical mutations are public, and the webhook can open a case from payload context.

- [ ] **Step 3: Implement HMAC simulator verification and controller auth**

Extend the existing simulator constructor with a third parameter so evaluation and workflow callers retain their current scenario and clock arguments:

```ts
constructor(
  scenarios: ReadonlyMap<string, SimulatorScenario> = new Map(),
  clock: Clock = new SystemClock(),
  webhookSecret: string = randomBytes(32).toString('hex'),
)
```

`verifyEvent` computes an HMAC hex digest and compares equal-length buffers with `timingSafeEqual`. It has no signing method. Application composition uses the configured simulator secret or `randomBytes(32).toString('hex')`; tests always inject a stable secret.

In `src/auth.ts`, hash both the supplied token and configured token with SHA-256, then compare the 32-byte digests. Missing configuration means disabled, not allow-all.

- [ ] **Step 4: Extract `WebhookIngress` and stop trusting webhook context**

Move raw signature verification, JSON parsing, normalized input creation, and `workflow.ingestAndDrive` invocation from `src/http.ts` to `src/webhook.ts`. Preserve typed error-to-status mapping. Canonical ingress resolves a case only from explicit `caseId` or Razorpay `notes.caseId`; it never passes `payload.context` as initial context.

`POST /api/recovery-cases` validates through `workflow.openCase` under the case lock. An existing byte-for-byte equal context is idempotent; a different context is `409`. Require controller auth before reading the body.

- [ ] **Step 5: Replace the signing oracle with `LabRunner`**

Keep `labScenarios` fixed, remove run-id-derived case identities, and give each isolated replay internally unique case ids. `LabRunner` constructs a fresh in-memory application using:

- `FixedClock`;
- `InMemoryRecoveryStore`;
- `FixtureDiagnosisEngine`;
- `DeterministicSimulator` with a fresh private secret;
- `WebhookIngress`.

Before delivery, pre-register the scenario's authored context in the isolated workflow. For each authored step, serialize the fixed payload, sign internally, optionally tamper after signing, and record expected versus observed status. Return the isolated `CaseDetail` needed by the panel, but neither secret nor signature. Reject unknown scenario keys with `404` and any extra payload field with `400`.

- [ ] **Step 6: Protect every canonical mutation route**

Apply controller auth to registration, evaluation POST, stop, escalate, and manual expire. Check auth before reading request bodies or case state. Keep all GET projections public. Keep the webhook outside bearer auth because `WebhookIngress` requires its HMAC. Remove Run Evaluation, Stop, and Escalate controls from the public HTML; never put the controller token in browser JavaScript, local storage, markup, or a query string. The replay button remains interactive.

- [ ] **Step 7: Run the boundary and regression suites**

Run: `npm test -- tests/application.test.ts tests/provider-contract.test.ts tests/http.test.ts tests/lab.test.ts tests/server.test.ts`

Expected: PASS. Lab replay changes no canonical metric, no response exposes signing bytes, wrong tokens mutate nothing, and the real webhook path still accepts a valid private HMAC.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 8: Commit and stop for Sol review**

```bash
git add src/auth.ts src/webhook.ts src/config.ts src/application.ts src/provider.ts src/http.ts src/lab.ts .env.example tests/application.test.ts tests/provider-contract.test.ts tests/http.test.ts tests/lab.test.ts
git commit -m "fix: isolate public demo mutations"
```

Review gate: the reviewer must confirm that a public caller can replay only server-authored scenarios, cannot obtain a signature, cannot alter the canonical store, and cannot reach model or provider credentials.

---

### Task 4: Required Razorpay Webhook Secret and Disabled-by-Default Recurring Retry

**Files:**

- Modify: `src/config.ts`
- Modify: `src/application.ts`
- Modify: `src/provider.ts`
- Modify: `.env.example`
- Modify: `tests/application.test.ts`
- Modify: `tests/provider.test.ts`
- Modify: `tests/provider-contract.test.ts`
- Modify: `tests/razorpay-adapter.test.ts`
- Modify: `tests/razorpay-integration.test.ts`
- Modify: `tests/lab.test.ts`
- Create: `tests/razorpay-recurring-proof.test.ts`
- Modify: `docs/research/razorpay-test-mode-mandate-setup.md`

**Interfaces:**

- Changes: `RazorpayTestModeOptions.webhookSecret: string` is required and `webhookSecret()` fallback is deleted.
- Produces: `RuntimeConfig.razorpayRecurringRetryEnabled: boolean`, parsed only from exact string `true`, default `false`.
- Produces: `RazorpayTestModeOptions.recurringRetryEnabled: boolean`.
- Behavior: when the flag is false, `retryEligibility` returns `{ eligible: false, reason: 'Razorpay recurring retry is unverified and disabled; use the fallback payment link' }` and `submitRetry` returns a failed result without network access.

- [ ] **Step 1: Add failing configuration and provider safety tests**

Add assertions that:

```ts
expect(() => loadConfig({
  PORT: '3000',
  RAZORPAY_KEY_ID: 'rzp_test_key',
  RAZORPAY_KEY_SECRET: 'api_secret',
})).toThrow(/RAZORPAY_WEBHOOK_SECRET/);
```

Also prove an HMAC made with the API secret is rejected when the webhook secret differs. Instantiate the Razorpay provider with `recurringRetryEnabled: false`, call `submitRetry` on an otherwise eligible mandate case, and assert the fetch spy has zero calls. Instantiate it with the flag true in adapter unit tests so the existing request-shape tests remain explicit.

- [ ] **Step 2: Run focused tests and confirm unsafe defaults**

Run: `npm test -- tests/application.test.ts tests/provider.test.ts tests/razorpay-adapter.test.ts`

Expected: FAIL because configuration currently permits a missing webhook secret and recurring retry is enabled implicitly.

- [ ] **Step 3: Enforce independent secrets and the retry feature gate**

Make `RAZORPAY_WEBHOOK_SECRET` mandatory whenever either Razorpay API credential is present. Remove the API-secret fallback from the provider. Parse `RAZORPAY_RECURRING_RETRY_ENABLED`; reject values other than absent, `false`, or `true` so a typo cannot enable it. Pass the boolean through application composition.

Guard both `retryEligibility` and `submitRetry`. The latter guard is required even if callers are expected to ask eligibility first. Keep payment-link creation unchanged and keep the `rzp_test_` key guard on both operations.

- [ ] **Step 4: Add the opt-in live proof test without faking success**

Create `tests/razorpay-recurring-proof.test.ts`, skipped unless all are set:

- `RAZORPAY_KEY_ID` beginning `rzp_test_`;
- `RAZORPAY_KEY_SECRET`;
- `RAZORPAY_WEBHOOK_SECRET`;
- `RAZORPAY_RECURRING_PROOF_PAYMENT_ID`;
- `RAZORPAY_RECURRING_PROOF_CUSTOMER_ID`;
- `RAZORPAY_RECURRING_PROOF_AMOUNT`;
- `RAZORPAY_RECURRING_PROOF_CURRENCY`.

The test uses real `fetch`, creates a case whose failed recurring attempt names the proof payment id, enables the flag, submits `caseId:retry`, asserts `status === 'submitted'` and `providerReference` matches `/^pay_/`, submits the same action identity again, and asserts the same reference with `idempotent === true`. It never contains credentials, customer details, card data, or a hard-coded claim that the test passed.

- [ ] **Step 5: Add the exact proof checklist to the research record**

Append a section titled `Live recurring retry proof gate` containing the ten numbered checks from the design spec. Mark the current state in prose as “not completed; retry disabled by default.” Do not add unchecked boxes that look like an incomplete implementation task, and do not record secret values or card data.

- [ ] **Step 6: Run provider and integration suites**

Run: `npm test -- tests/application.test.ts tests/provider.test.ts tests/provider-contract.test.ts tests/razorpay-adapter.test.ts tests/razorpay-integration.test.ts tests/razorpay-recurring-proof.test.ts`

Expected: PASS. The two live suites report skipped unless their explicit environment is present; the output must not claim recurring proof when skipped.

Run: `npm run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit and stop for Sol review**

```bash
git add src/config.ts src/application.ts src/provider.ts .env.example tests/application.test.ts tests/provider.test.ts tests/provider-contract.test.ts tests/razorpay-adapter.test.ts tests/razorpay-integration.test.ts tests/lab.test.ts tests/razorpay-recurring-proof.test.ts docs/research/razorpay-test-mode-mandate-setup.md
git commit -m "fix: gate unverified recurring retries"
```

Review gate: fallback-link integration must remain enabled; recurring retry must make zero network calls by default and no documentation may say the proof passed.

---

### Task 5: Automatic Bounded Expiry Sweeper

**Files:**

- Create: `src/expiry.ts`
- Modify: `src/application.ts`
- Modify: `src/server.ts`
- Modify: `src/http.ts`
- Modify: `tests/orchestration.test.ts`
- Create: `tests/expiry.test.ts`
- Modify: `tests/server.test.ts`
- Modify: `tests/persistence.test.ts`

**Interfaces:**

- Produces: `ExpirySweepResult` and `ExpirySweeper` exactly as declared in the design spec.
- Produces: `startExpiryScheduler(sweeper: ExpirySweeper, options?: { intervalMilliseconds?: number; onError?: (error: unknown) => void }): { stop(): void }`.
- Changes: `RecoveryApplication.expirySweeper: ExpirySweeper`.
- Preserves: authenticated `POST /api/expire`, now delegating to `expirySweeper.sweep()`.

- [ ] **Step 1: Write failing sweeper and scheduler tests**

In `tests/expiry.test.ts`, construct 105 lapsed fallback cases and assert the first `sweep()` inspects 100, expires 100, returns `moreDue: true`, and leaves 5 open. Assert the second sweep expires 5 and returns `moreDue: false`.

Use Vitest fake timers to assert:

- one sweep runs immediately at scheduler start;
- another runs after 60,000 ms;
- a second tick does not overlap a still-pending first sweep;
- a rejected sweep reaches `onError` and the following tick still runs;
- `stop()` prevents later ticks.

Add an ordering test in `tests/orchestration.test.ts`: expiry and a matching success start concurrently for one case; after both settle, there is one coherent case with no duplicate audit ids and, when the success is explicitly correlated, final status `recovered`.

- [ ] **Step 2: Run focused tests and confirm no scheduler exists**

Run: `npm test -- tests/expiry.test.ts tests/orchestration.test.ts -t "expir|scheduler"`

Expected: FAIL because there is no `ExpirySweeper` or automatic schedule.

- [ ] **Step 3: Implement the bounded sweeper**

`ExpirySweeper.sweep(limit = 100)` validates `limit` as a positive integer no greater than 100, gets `limit + 1` due ids to calculate `moreDue`, and expires only the first `limit`. It passes the workflow clock's current ISO timestamp through the store query and relies on the workflow's lock-protected recheck before changing a case.

Return only ids that changed from a non-terminal status to `exhausted`, not cases that were already terminal by the time their lock was acquired.

- [ ] **Step 4: Start and stop the scheduler with the server**

Compose `expirySweeper` in `createRecoveryApplication`. In `bootstrap`, after store initialization and seeded-batch publication, start the scheduler before listening. Attach a `server.once('close', scheduler.stop)` hook. The timer calls `unref()` so it cannot keep tests alive.

Change manual `POST /api/expire` to return `ExpirySweepResult` and retain controller authentication from Task 3.

- [ ] **Step 5: Run memory, server, and PostgreSQL expiry tests**

Run: `npm test -- tests/expiry.test.ts tests/orchestration.test.ts tests/server.test.ts tests/http.test.ts`

Expected: PASS.

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npm test -- tests/persistence.test.ts`

Expected: PASS and not skipped; the expiry query returns only due, non-terminal cases and respects the requested limit.

- [ ] **Step 6: Commit and stop for Sol review**

```bash
git add src/expiry.ts src/application.ts src/server.ts src/http.ts tests/orchestration.test.ts tests/expiry.test.ts tests/server.test.ts tests/persistence.test.ts
git commit -m "feat: sweep expired fallback links"
```

Review gate: no test or route may iterate all cases to expire links, and fake-timer evidence must show non-overlap and recovery after an error.

---

### Task 6: PostgreSQL Deployment Readiness and Health

**Files:**

- Modify: `src/config.ts`
- Modify: `src/application.ts`
- Modify: `src/http.ts`
- Modify: `src/server.ts`
- Modify: `package.json`
- Modify: `.env.example`
- Modify: `Procfile`
- Modify: `render.yaml`
- Modify: `tests/application.test.ts`
- Modify: `tests/http.test.ts`
- Modify: `tests/server.test.ts`

**Interfaces:**

- Produces: `RuntimeConfig.requireDatabase: boolean`, exact `true`/`false` parsing, default `false`.
- Produces: `RecoveryApplication.persistenceMode: 'postgresql' | 'memory'`.
- Produces: public `GET /healthz` returning `{ ok: true, persistence: 'postgresql' | 'memory' }` after `store.healthCheck()`.
- Produces: package script `test:postgres` running both PostgreSQL suites.

- [ ] **Step 1: Write failing database-required and readiness tests**

Add tests that `loadConfig({ PORT: '3000', REQUIRE_DATABASE: 'true' })` throws a clear error when `DATABASE_URL` is missing, rejects `REQUIRE_DATABASE=yes`, and accepts `REQUIRE_DATABASE=false` for local memory use.

Add HTTP tests with a healthy store and a store whose `healthCheck` throws. Assert healthy `/healthz` is `200` with the persistence mode and unhealthy is `503` with `{ ok: false }` but no database URL or raw driver error.

Add a server test proving bootstrap does not call `listen` when a required database cannot initialize.

- [ ] **Step 2: Run the focused tests**

Run: `npm test -- tests/application.test.ts tests/http.test.ts tests/server.test.ts -t "database|required|health"`

Expected: FAIL because the configuration and readiness route do not exist.

- [ ] **Step 3: Implement fail-closed public persistence and health**

Parse `REQUIRE_DATABASE`. Throw `REQUIRE_DATABASE=true requires DATABASE_URL` during configuration load. Expose `persistenceMode` from composition based on the selected store. `/healthz` calls `healthCheck`; map success to `200` and failure to a generic `503` body while logging the actual error server-side.

Keep schema initialization before seeded batch publication and before `listen`. Do not add a release command that starts a second copy of the application or provisions an add-on.

- [ ] **Step 4: Add reproducible PostgreSQL commands**

Add to `package.json`:

```json
"test:postgres": "vitest run tests/persistence.test.ts tests/postgres-concurrency.test.ts"
```

Document the disposable local database command later in Task 7. Change `render.yaml` health check to `/healthz` and add `REQUIRE_DATABASE` as an explicit environment setting only if Render is intended to have a database; otherwise leave it `false` and label Render as the non-durable alternative. Update `Procfile` comments to state that Heroku must set `REQUIRE_DATABASE=true` and attach `DATABASE_URL`; the process remains `web: npm start`.

- [ ] **Step 5: Run deployment-facing verification**

Run: `npm test -- tests/application.test.ts tests/http.test.ts tests/server.test.ts`

Expected: PASS.

Run: `TEST_DATABASE_URL=$TEST_DATABASE_URL npm run test:postgres`

Expected: PASS and neither suite skipped.

Run: `npm run build && node dist/src/server.js`

Expected: server starts in local memory mode when `REQUIRE_DATABASE` is absent. Stop it with Ctrl-C after `curl -fsS http://127.0.0.1:3000/healthz` returns `{"ok":true,"persistence":"memory"}`.

- [ ] **Step 6: Commit and stop for Sol review**

```bash
git add src/config.ts src/application.ts src/http.ts src/server.ts package.json .env.example Procfile render.yaml tests/application.test.ts tests/http.test.ts tests/server.test.ts
git commit -m "feat: require durable demo storage"
```

Review gate: the public deployment can be configured to fail closed without PostgreSQL, while the default local command remains usable in memory.

---

### Task 7: Dashboard and README Claim Polish

**Files:**

- Modify: `src/application.ts`
- Modify: `src/http.ts`
- Modify: `README.md`
- Modify: `tests/http.test.ts`
- Modify: `tests/application.test.ts`

**Interfaces:**

- Produces: `RecoveryApplication.runtimeSummary`:

```ts
export interface RuntimeSummary {
  readonly payments: 'Deterministic simulator' | 'Razorpay Test Mode';
  readonly liveDiagnosis: string;
  readonly seededEvaluation: 'Simulator payments · deterministic fixture diagnosis';
  readonly persistence: 'PostgreSQL' | 'In-memory (non-durable)';
  readonly recurringRetry: 'Disabled pending Test Mode proof' | 'Enabled for Test Mode proof';
}
```

- Produces: public `GET /api/runtime` returning that object.
- Preserves: all existing case, evaluation, metric, theme, and lab interactions.

- [ ] **Step 1: Add failing runtime-copy, route, contrast, and README tests**

In application tests, compose fixture, Pincc Claude, Pincc non-Claude, Anthropic, simulator, Razorpay, memory, and PostgreSQL configurations and assert exact runtime labels.

In HTTP tests, assert the dashboard fetches `/api/runtime` and contains visible labels for Payments, Live diagnosis, Seeded evaluation, Persistence, and Recurring retry. Assert it does not apply a single “AI-powered” label to the seeded batch and contains no Run Evaluation, Stop, or Escalate control.

Pin a dark primary-button metadata pair that meets 4.5:1 contrast. Use dark text `#334155` on the dark-theme primary background `#f4f4f5`, and assert the CSS contains:

```css
:root[data-theme="dark"] .btn-primary .button-meta{color:#334155}
```

Add README assertions for the live URL, exact video placeholder, both Pincc routes, synthetic labels, PostgreSQL command, and recurring-unverified wording.

- [ ] **Step 2: Run the focused presentation tests**

Run: `npm test -- tests/application.test.ts tests/http.test.ts -t "runtime|dashboard|contrast|README|Pincc"`

Expected: FAIL because `/api/runtime`, component labels, corrected contrast rule, and README claims do not yet exist.

- [ ] **Step 3: Compose and serve runtime facts**

Build `runtimeSummary` from the selected provider, diagnosis engine/model configuration, persistence mode, and recurring flag during application composition. Do not send credentials, base URLs with embedded auth, or environment variable values. Serve it from `/api/runtime` and render five compact labels in the dashboard header or workspace snapshot.

Label the evaluation panel `Simulator payments · deterministic fixture diagnosis` even when live diagnosis is Pincc. Change the existing “Synthetic mode” badge so it does not hide which component is synthetic.

- [ ] **Step 4: Fix dark-mode button metadata contrast**

Scope the new `#334155` metadata color to `.btn-primary .button-meta` in dark mode. Keep primary button text on `--primary-foreground`; do not globally darken muted text or badge text. Verify focus-visible styling remains.

- [ ] **Step 5: Rewrite README claims and operational instructions**

At the top, add:

```markdown
**Live demo:** https://recovery-loop-ecd128e33dca.herokuapp.com/

**Demo video:** Recording deferred; no video URL is published yet.
```

Correct Pincc routing: Claude model ids use `${PINCC_BASE_URL}/v1/messages` with the Messages contract; other configured model ids use `${PINCC_BASE_URL}/v1/chat/completions` with the OpenAI-compatible contract.

State separately that public batch payments and diagnosis are deterministic fixtures, while configured live cases may use Pincc. Remove all webhook-secret fallback language. Document pre-registration plus `notes.caseId`, controller bearer auth, isolated lab behavior, automatic expiry, `REQUIRE_DATABASE=true`, and recurring retry disabled pending proof.

Document local PostgreSQL verification without claiming it was run:

```bash
docker run --name recovery-loop-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=recovery_loop_test -p 5432:5432 -d postgres:16
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/recovery_loop_test npm run test:postgres
```

State that `heroku-postgresql:essential-0` is a human-approved paid gate and is not auto-provisioned.

- [ ] **Step 6: Run the dashboard, README, and full test suite**

Run: `npm test -- tests/application.test.ts tests/http.test.ts tests/lab.test.ts tests/server.test.ts`

Expected: PASS.

Run: `npm test && npm run typecheck && npm run build`

Expected: all tests pass, typecheck passes, and the production build succeeds.

- [ ] **Step 7: Commit and stop for Sol review**

```bash
git add src/application.ts src/http.ts README.md tests/http.test.ts tests/application.test.ts
git commit -m "docs: clarify demo runtime claims"
```

Review gate: a reader must be able to tell which path uses simulator payments, which path uses Pincc, what is proven against Razorpay, whether persistence is durable, and why there is no video link.

---

### Task 8: Full Verification and Controller Release Gates

**Files:**

- Modify only if verification finds a documented mismatch: `README.md`
- No production-code edits are planned in this task.

**Interfaces:**

- Consumes: every interface and test from Tasks 1–7.
- Produces: a verified release commit deployed to Heroku, durable PostgreSQL state, public GitHub visibility, and closed issue #1.
- External-state rule: database provisioning, config changes, deployment, visibility change, and issue closure are controller actions performed only after human approval where specified.

- [ ] **Step 1: Verify the repository before external changes**

Run:

```bash
npm ci
npm test
npm run typecheck
npm run build
```

Expected: every non-live test passes; live Razorpay proof tests may be reported as skipped, never passed, unless their explicit Test Mode environment is present.

Run with a disposable PostgreSQL 16 database:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/recovery_loop_test npm run test:postgres
```

Expected: both PostgreSQL suites pass and are not skipped.

- [ ] **Step 2: Perform the full secret and history scan**

Confirm `gitleaks` is installed; on the current macOS controller, install it with Homebrew only if the version check fails:

```bash
gitleaks version
brew install gitleaks
gitleaks version
```

Then run:

```bash
gitleaks git --log-opts="--all" --verbose
gitleaks dir . --verbose
git grep -nEI '(rzp_(test|live)_[A-Za-z0-9]+|sk-ant-[A-Za-z0-9_-]+|PINCC_API_KEY=.+|RAZORPAY_KEY_SECRET=.+|RAZORPAY_WEBHOOK_SECRET=.+)' -- . ':!package-lock.json'
```

Expected: both gitleaks commands exit zero and `git grep` prints no credential value. Example variable names with empty values are allowed. If any real credential is found, stop: rotate it first, clean the complete Git history, and rerun all three scans before continuing.

- [ ] **Step 3: Controller cost gate — provision Heroku PostgreSQL only after explicit human approval**

Read-only precheck:

```bash
heroku addons --app recovery-loop
heroku config:get DATABASE_URL --app recovery-loop
```

Current audited expectation: no PostgreSQL add-on and no `DATABASE_URL`.

After the human explicitly accepts the approximately US$5/month Essential-0 cost, run exactly once:

```bash
heroku addons:create heroku-postgresql:essential-0 --app recovery-loop
heroku pg:wait --app recovery-loop
heroku pg:info --app recovery-loop
```

Expected: an Essential-0 database is available and attached as `DATABASE_URL`. Do not provision a second add-on if one is already attached.

- [ ] **Step 4: Controller secret/config gate**

Using values supplied through the controller's secure secret mechanism and exported as shell variables, set the secrets without printing them:

```bash
heroku config:set CONTROL_PLANE_TOKEN="$CONTROL_PLANE_TOKEN" SIMULATOR_WEBHOOK_SECRET="$SIMULATOR_WEBHOOK_SECRET" --app recovery-loop
```

Then set non-secret flags:

```bash
heroku config:set REQUIRE_DATABASE=true RAZORPAY_RECURRING_RETRY_ENABLED=false --app recovery-loop
```

Do not set Razorpay API credentials on the public simulator deployment. Set Pincc only if the human wants live-case diagnosis and accepts credit consumption; the public lab and seeded batch remain fixture-only either way.

- [ ] **Step 5: Deploy and verify persistence before making GitHub public**

Deploy the reviewed commit:

```bash
git push heroku HEAD:main
heroku ps --app recovery-loop
heroku logs --tail --app recovery-loop
```

Stop log tailing after startup shows schema initialization, seeded-batch readiness, expiry scheduler startup, and HTTP listening with no secret value.

Verify:

```bash
curl -fsS https://recovery-loop-ecd128e33dca.herokuapp.com/healthz
curl -fsS https://recovery-loop-ecd128e33dca.herokuapp.com/api/runtime
curl -fsS https://recovery-loop-ecd128e33dca.herokuapp.com/api/metrics
curl -fsS https://recovery-loop-ecd128e33dca.herokuapp.com/api/evaluation
```

Record the evaluation `recordedAt`, seed, total cases, and one case id. Restart and query again:

```bash
heroku ps:restart web --app recovery-loop
curl -fsS https://recovery-loop-ecd128e33dca.herokuapp.com/healthz
curl -fsS https://recovery-loop-ecd128e33dca.herokuapp.com/api/evaluation
```

Expected: health reports PostgreSQL; runtime labels simulator payments accurately; the same evaluation `recordedAt`, seed, totals, and case data survive the restart. Replay one public lab scenario and verify `/api/metrics` is byte-for-byte unchanged before and after.

- [ ] **Step 6: Controller visibility gate**

After the scan and deployed smoke checks are clean, inspect current visibility:

```bash
gh repo view rabbive/recovery-loop --json visibility,url
```

If still private, change it only now:

```bash
gh repo edit rabbive/recovery-loop --visibility public --accept-visibility-change-consequences
gh repo view rabbive/recovery-loop --json visibility,url
```

Expected: visibility is `PUBLIC` and the repository URL is accessible without authentication.

- [ ] **Step 7: Close issue #1 with evidence**

Read the issue immediately before closing:

```bash
gh issue view 1 --repo rabbive/recovery-loop --comments
```

Close it with a comment that names the reviewed commit, passing unit/typecheck/build/PostgreSQL suites, clean gitleaks history scan, durable restart check, and live demo URL. Do not claim the recurring retry proof or a demo video exists.

```bash
release_commit="$(git rev-parse HEAD)"
gh issue close 1 --repo rabbive/recovery-loop --comment "Hackathon readiness is complete at ${release_commit}. Unit tests, typecheck, build, and PostgreSQL concurrency/persistence suites pass; full Git history passed the secret scan; Heroku state survives restart; public demo: https://recovery-loop-ecd128e33dca.herokuapp.com/. Razorpay recurring retry remains disabled pending account-gated Test Mode proof. Demo video remains deferred."
```

- [ ] **Step 8: Record final evidence without another code change**

Capture the release commit, Heroku release version, database plan name, health response, evaluation identity, public repository visibility, issue state, and skipped live-proof status in the controller handoff. Video recording and final video link remain assigned to the human.

No commit is expected for this evidence-only step. If README had to be corrected to match observed public behavior, rerun Step 1 and commit only that correction as:

```bash
git add README.md
git commit -m "docs: align public demo evidence"
```
