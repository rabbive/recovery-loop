# Hackathon Readiness Design

**Date:** 2026-08-28

**Status:** Approved minimum hardening design

**Scope:** Make the existing Recovery Loop MVP safe, persistent, defensible, and presentable for a public hackathon demo. Video recording and the final video URL remain human-owned and are excluded.

## Outcome

Recovery Loop remains one TypeScript application with one Recovery Case aggregate, one deterministic policy authority, one simulator, and one Razorpay Test Mode adapter. This hardening pass closes the gaps that would let concurrency duplicate an action, let an unrelated success inflate recovered revenue, let public callers mutate the demo, or let a Heroku restart erase state.

The public deployment exposes read-only merchant projections and a bounded replay lab. Canonical state changes come only from a verified provider webhook, a bearer-authenticated controller endpoint, the internal seeded-batch publisher, or the internal expiry scheduler. PostgreSQL is required on the public deployment. The simulator remains the reproducible payment system for the published batch; Pincc is used only for explicitly identified live-case diagnosis, never for the replay lab or seeded evaluation.

## Architectural rulings

### 1. Serialize every mutation of one Recovery Case

Provider idempotency is necessary but does not make the current workflow safe. Two requests can both load the same pending action, both call the provider, and then overwrite each other's saved case. Recovery Loop therefore moves per-case serialization into the `RecoveryStore` contract:

```ts
export interface RecoveryCaseTransaction {
  get(): Promise<RecoveryCase | undefined>;
  save(recoveryCase: RecoveryCase): Promise<void>;
}

export interface RecoveryStore {
  withCaseLock<T>(
    caseId: string,
    operation: (transaction: RecoveryCaseTransaction) => Promise<T>,
  ): Promise<T>;
  get(id: string): Promise<RecoveryCase | undefined>;
  all(): Promise<RecoveryCase[]>;
  findLapsedFallbackCaseIds(now: string, limit: number): Promise<string[]>;
  healthCheck(): Promise<void>;
}
```

`InMemoryRecoveryStore` maintains a promise tail per case id. `PostgresRecoveryStore` begins a transaction, takes `pg_advisory_xact_lock(hashtextextended(caseId, 0))`, and uses the same checked-out client for every read and write in the callback. The advisory lock works before a case row exists, so concurrent controller registrations cannot both open it. Hash collisions can serialize unrelated cases but cannot weaken safety.

Every public workflow mutation acquires this lock. The webhook boundary calls one `ingestAndDrive` operation that deduplicates and ingests the event, diagnoses, authorizes, and executes the next action under one per-case lock. The method may open a missing case only when a trusted internal caller supplies validated initial context; canonical Razorpay ingress never supplies webhook-body context and requires pre-registration. `drive`, `stop`, `escalate`, and `expireLapsedFallbackLink` use the same boundary. Private transaction-aware helpers avoid trying to reacquire the same non-reentrant lock.

The provider call is allowed while the lock and PostgreSQL transaction are held. This trades per-case throughput for a small, auditable safety boundary appropriate to an MVP that performs at most two provider operations per case. Different cases still run concurrently. If the process dies after a provider call and before commit, the database rolls back; the next drive uses the same deterministic action idempotency key, and the provider adapter resolves the existing order or link rather than creating another. A provider timeout rolls back and is retried through that same identity.

Acceptance invariant: `Promise.all` over concurrent drives, duplicate webhook deliveries, and controller requests for one case performs at most one provider operation for each of `caseId:retry` and `caseId:fallback_link` in both store implementations.

### 2. Attribute recovered revenue to a specific approved action

The presence of any old recovery action is not evidence that a later payment was caused by it. The normalized event and case record gain explicit correlation data:

```ts
export interface ProviderEvent {
  // existing fields
  readonly providerActionReference?: string;
  readonly actionIdempotencyKey?: string;
}

export interface RecoveryAttribution {
  readonly actionId: string;
  readonly actionKind: 'retry' | 'fallback_link';
  readonly idempotencyKey: string;
  readonly providerReference: string;
  readonly providerPaymentId: string;
  readonly eventId: string;
  readonly occurredAt: string;
}

export interface RecoveryCase {
  // existing fields
  readonly recoveryAttribution?: RecoveryAttribution;
}
```

A `payment_succeeded` event is attributed only when all conditions hold:

1. The case contains the named `retry` or `fallback_link` action.
2. A recorded `PolicyDecision` allowed that action kind no later than the action's creation.
3. The action has a real `providerReference`; references are never synthesized.
4. The event matches either the action's provider reference or its idempotency key.
5. `event.occurredAt` is not earlier than `action.createdAt`.
6. The event carries a provider payment id for reconciliation.

For a retry, the payment id normally equals the action's provider reference. For a fallback link, normalization reads the payment-link id from Razorpay's nested payment-link entity or `payment_link_id`, and reads `notes.recoveryActionKey`. Orders and payment links created by the adapter include `caseId` and `recoveryActionKey` in their notes. Synthetic success fixtures carry the same explicit references.

An attributed success may move `diagnosed`, `retry_scheduled`, `fallback_link_available`, `escalated`, or `exhausted` to `recovered`. This preserves honest reconciliation when a payment settles after automation escalated the case or after a link expired. A success without a match never increases `recoveredAmount`: an active case stands down as `stopped`, while an already terminal case retains its outcome and records `uncorrelated_success`. A stopped case is not reopened.

The seeded evaluation is changed so its late-success-after-exhaustion case expires a successfully created fallback link and then delivers a payment explicitly tied to that link. The previous scenario in which two provider operations failed without references and a later payment was nevertheless credited is removed. Recovery-path metrics derive from `recoveryAttribution`, not from which failed actions happen to remain on the case. Published seed-42 totals are updated together in tests, README copy, and dashboard copy after the new deterministic run is measured; no old figure is carried forward by assumption.

### 3. Separate the public replay lab from canonical state

The public application must not be a webhook-signing oracle. `sim:<raw>` is removed. The deterministic simulator verifies HMAC-SHA256 with a private simulator webhook secret, using the same constant-time comparison shape as the Razorpay adapter. Tests inject a fixed secret; an unconfigured local simulator process generates an ephemeral secret at startup.

The lab no longer returns a raw signed body and signature. It exposes:

- `GET /api/lab/scenarios`: metadata for the four fixed scenarios.
- `POST /api/lab/replay` with `{ "scenario": "open" | "duplicate" | "ordering" | "forged" }`.

`LabRunner` creates an isolated in-memory store, fixed clock, deterministic fixture diagnosis engine, and simulator secret for each replay. It pre-registers the scenario's authored renewal context in that isolated store, signs only payloads from `labScenarios`, sends those bytes through the same `WebhookIngress` service used by `POST /webhooks/razorpay`, and returns the declared status beside the observed status and an isolated case projection. The forged scenario signs the authored body and mutates only the delivered bytes. No replay case is saved to the canonical store, no signing material leaves the server, no arbitrary payload is accepted, and no replay invokes Pincc or Razorpay. A request performs at most the fixed steps in one named scenario.

Canonical mutation routes require `Authorization: Bearer <CONTROL_PLANE_TOKEN>`:

- `POST /api/recovery-cases`
- `POST /api/cases/:id/stop`
- `POST /api/cases/:id/escalate`
- `POST /api/evaluation`
- the retained manual `POST /api/expire` diagnostic route

When `CONTROL_PLANE_TOKEN` is absent, those routes are disabled with `404`; they never become unauthenticated local conveniences. Token comparison is constant-time after normalizing both values to fixed-length SHA-256 digests. Read-only projections and the isolated replay endpoint remain public. `POST /webhooks/razorpay` remains outside bearer auth because its provider signature is its authentication boundary.

The public browser never receives or stores the controller token. The dashboard removes the Run Evaluation, Stop, and Escalate controls and presents canonical cases as read-only. Seed publication remains an internal boot operation, controller mutations remain API-only, and the replay lab is the public interactive surface.

This prevents arbitrary public callers from minting events, changing cases, republishing batches, stopping cases, or spending Pincc credits.

### 4. Make provider ingress explicit and secrets independent

`RazorpayTestModeOptions.webhookSecret` becomes required. The adapter never falls back to `keySecret`, and application composition refuses Razorpay credentials unless `RAZORPAY_WEBHOOK_SECRET` is also configured. API credentials authenticate Recovery Loop to Razorpay; the webhook secret authenticates Razorpay to Recovery Loop. They are different credentials with different rotation scopes.

Native Razorpay events are accepted only when they resolve a case id from a top-level synthetic test field or the real payment entity's `notes.caseId`. Recovery Loop does not guess a case from customer, amount, or timing.

For a real Test Mode flow, the controller first calls:

```http
POST /api/recovery-cases
Authorization: Bearer <CONTROL_PLANE_TOKEN>
Content-Type: application/json

{
  "id": "renewal-2026-08-acme-42",
  "context": {
    "customerId": "cust_acme_42",
    "subscriptionId": "sub_acme_42",
    "orderId": "merchant-renewal-42",
    "amount": 4999,
    "currency": "INR",
    "dueAt": "2026-08-28T00:00:00.000Z"
  }
}
```

The endpoint validates the immutable context and returns `201`; the merchant then writes `notes.caseId` on the Razorpay order, payment link, or payment created for that renewal. The first signed `payment.failed` webhook resolves those notes to the pre-registered case. A missing case id returns `400`; a valid but unknown id returns `404`; neither opens a case from untrusted provider payload context. The simulator-only test path may still open a case from a fixed authored lab fixture inside the isolated lab, never through the public canonical webhook.

### 5. Require PostgreSQL on Heroku without making local development brittle

The application keeps the in-memory store for unit tests, the isolated lab, and local development. `REQUIRE_DATABASE=true` makes startup fail before listening when `DATABASE_URL` is absent. The Heroku app sets this flag after a PostgreSQL add-on is attached. `GET /healthz` calls `store.healthCheck()` and returns `200` only when the configured store is reachable.

The PostgreSQL adapter continues initializing the idempotent schema before the server listens. Its new per-case lock and expiry query are tested against a real database through `TEST_DATABASE_URL`. `npm run test:postgres` runs `tests/persistence.test.ts` and `tests/postgres-concurrency.test.ts`; a documented Docker command provides a disposable local PostgreSQL 16 instance. The normal test suite remains credential-free.

The chosen deployment database is Heroku Postgres Essential-0: 1 GB and 20 connections, currently billed at approximately US$5/month. Provisioning it is a human/controller cost gate, not an implementation step. No `app.json` or automatic deployment hook provisions a paid add-on. The exact gated command is:

```bash
heroku addons:create heroku-postgresql:essential-0 --app recovery-loop
```

After the human approves the charge, the controller verifies `DATABASE_URL`, runs the PostgreSQL suites against a disposable local database before deployment, deploys, checks `/healthz`, publishes once through the authenticated endpoint if needed, restarts the dyno, and verifies that the same evaluation run and case count survive.

### 6. Expire fallback links automatically and in bounded batches

`ExpirySweeper` is an internal application service:

```ts
export interface ExpirySweepResult {
  readonly inspected: number;
  readonly expiredCaseIds: readonly string[];
  readonly moreDue: boolean;
}

export class ExpirySweeper {
  sweep(limit?: number): Promise<ExpirySweepResult>;
}
```

`RecoveryStore.findLapsedFallbackCaseIds(now, limit)` returns only non-terminal cases whose non-failed fallback action has `expiresAt <= now`, ordered by expiry and case id. PostgreSQL queries `recovery_actions` joined to `recovery_cases`; memory filters the aggregates. `sweep` defaults to 100 cases and calls the lock-protected `expireLapsedFallbackLink` for each. A scheduler runs one sweep after bootstrap and every 60 seconds thereafter. It skips a tick while the previous sweep is still running, catches and logs errors without stopping the HTTP server, and `unref()`s the Node timer. If `moreDue` is true, the next interval continues; one tick never processes an unbounded table.

The authenticated manual expiry endpoint invokes the same sweeper and exists only for operational verification. It is not the production mechanism.

### 7. Present the system honestly

The dashboard reports the runtime components separately:

- **Payments:** `Deterministic simulator` or `Razorpay Test Mode`.
- **Live diagnosis:** `Pincc · <model>`, `Anthropic · <model>`, or `Deterministic fixtures`.
- **Seeded evaluation:** always `Simulator payments · deterministic fixture diagnosis`.
- **Persistence:** `PostgreSQL` or `In-memory (non-durable)`.

This information comes from a read-only `GET /api/runtime` projection assembled during application composition; the browser does not infer it from credentials. Copy never says the synthetic batch used Pincc. The public README links to `https://recovery-loop-ecd128e33dca.herokuapp.com/`, labels every batch figure synthetic, documents Claude Pincc models at `/v1/messages` and non-Claude compatible models at `/v1/chat/completions`, and includes this exact video placeholder:

> **Demo video:** Recording deferred; no video URL is published yet.

Dark-mode primary-button metadata uses a foreground color with at least 4.5:1 contrast against the light primary button background. A dashboard HTML test pins the selected color pair and the runtime labels.

### 8. Keep recurring retry behind proof, not optimism

The real fallback payment-link integration remains enabled because it has been exercised against Razorpay Test Mode. Recurring retry is account-gated and has not been exercised. `RAZORPAY_RECURRING_RETRY_ENABLED` therefore defaults to `false`. When false, `RazorpayTestModeProvider.retryEligibility` returns an explicit unsupported reason and policy steps down to the fallback link. Setting it to `true` changes only eligibility; the existing Test-Mode-key guard, mandate-field checks, context checks, action bound, per-case lock, and provider idempotency remain mandatory.

The flag may be enabled only after this exact Test Mode proof checklist is completed and recorded without secrets or card data:

1. Obtain Razorpay confirmation that recurring card payments are enabled on the Test Mode account.
2. Create a Test Mode customer and complete a card-mandate authorization transaction.
3. Fetch the customer token and record a sanitized response showing a confirmed recurring mandate.
4. Create a subsequent Test Mode payment using the documented recurring API and record its returned payment id.
5. Produce or identify a failed subsequent mandate payment, wait the provider-required interval where applicable, and pre-register its Recovery Case with the same amount, currency, customer, subscription, and order context.
6. Run the opt-in `tests/razorpay-recurring-proof.test.ts` with the Test Mode payment id and confirmed expected context. It must submit one retry, return a real `pay_...` reference, and submit the same action identity again without creating a second payment.
7. Deliver a valid Razorpay-signed success webhook for that returned payment id and prove the case records `recoveryAttribution` for the approved retry.
8. Deliver a success with a different payment id and prove recovered revenue does not change.
9. Store the date, Test Mode account capability, sanitized request/response shapes, webhook event ids, and command results in `docs/research/razorpay-test-mode-mandate-setup.md`.
10. Only then set `RAZORPAY_RECURRING_RETRY_ENABLED=true` on a non-public Test Mode integration app. The public hackathon demo may continue using simulator payments and the proven fallback-link integration.

Until all ten checks pass, README and dashboard language says the retry adapter is implemented but live recurring submission is unverified and disabled by default.

## End-to-end data flow

### Canonical Razorpay flow

1. An authenticated controller pre-registers immutable renewal context.
2. The merchant puts `caseId` and, for recovery-created resources, `recoveryActionKey` in Razorpay notes.
3. Razorpay sends raw bytes and an HMAC signature.
4. `WebhookIngress` verifies with `RAZORPAY_WEBHOOK_SECRET` before parsing.
5. Normalization resolves only explicit notes, payment ids, link ids, and event identity.
6. `RecoveryWorkflow.ingestAndDrive` takes the per-case lock, deduplicates the event, applies diagnosis and policy, records an action intent, calls the provider, and persists the result atomically.
7. A success event is matched to one approved action and its provider reference before recovered revenue is recorded.
8. Read-only projections render the aggregate and its attribution.

### Public lab flow

1. A visitor chooses one predefined scenario.
2. `LabRunner` builds an isolated simulator application with fixture diagnosis and pre-registers the authored renewal context.
3. Server-owned bytes are signed privately and passed to the same `WebhookIngress` service.
4. The response compares declared and observed status and returns the isolated case timeline.
5. The isolated store is discarded; canonical metrics and Pincc credits are unchanged.

### Expiry flow

1. The scheduler asks the store for at most 100 due case ids.
2. Each case is locked and rechecked against the current clock.
3. A still-lapsed link is marked failed, audited, and the case becomes exhausted.
4. A concurrent matched success either runs before expiry or after it; in both orders the same case lock yields a deterministic result, and a matched late success may transition exhausted to recovered.

## Failure handling

- Invalid signatures, missing webhook secrets, malformed JSON, missing explicit case identity, and unknown case ids cause no state change.
- Concurrent duplicate requests wait on one per-case lock and observe the committed result.
- Model timeout or malformed output still escalates without an action, as ADR-0001 requires.
- Provider failure is recorded against the claimed action; a retry failure steps down and a link-creation failure exhausts.
- Process death after a provider call is recovered by replaying the same action identity after transaction rollback.
- Unmatched successes are audited but never counted as recovered revenue.
- Scheduler errors are logged and retried on the next bounded tick; they do not take down HTTP serving.
- Database-required deployments fail closed at startup and fail readiness while PostgreSQL is unavailable.
- Missing controller authentication disables canonical mutation routes.
- Recurring retry remains unavailable until an explicit operator flag is set after live proof.

## Security boundaries

- Diagnosis receives projected signals only and has no provider credentials.
- Deterministic policy remains the sole action authorizer.
- Provider webhook HMAC and controller bearer auth are independent boundaries.
- API key secret, webhook secret, controller token, Pincc key, Anthropic key, and database URL are runtime-only and never interchangeable.
- Simulator signing is HMAC-based, private, and never exposed as a public signing service.
- Public lab execution is fixed, isolated, bounded, and credential-free.
- Public read projections escape provider-controlled strings before HTML interpolation.
- Real money remains impossible: the provider refuses non-`rzp_test_` keys.

## Verification and release gates

Implementation is reviewed one task at a time. Before any external-state change, the complete suite, PostgreSQL suite, typecheck, build, and HTTP smoke tests must pass. Then the controller performs a full working-tree and Git-history secret scan. Any finding stops release until the credential is rotated and history is cleaned.

Only after code review and a clean scan may the controller, with explicit human approval where required:

1. provision the paid Essential-0 database;
2. configure protected runtime values;
3. deploy and verify durable state across restart;
4. change `rabbive/recovery-loop` from private to public;
5. close GitHub issue #1 with the verified demo URL and test summary.

Video creation and a final video link are intentionally deferred to the human and are not release blockers for the code plan.

## Audited blocker coverage

| Audited blocker | Design ruling |
| --- | --- |
| Concurrent duplicate actions | Store-owned per-case lock in memory and PostgreSQL, with cross-pool concurrency proof |
| Weak success attribution | Explicit approved-action, provider-reference, payment-id, and time correlation |
| Forgeable public simulator and mutations | Private simulator HMAC, isolated fixed replay runner, bearer-protected canonical mutations |
| Webhook-secret fallback and missing real context | Required independent webhook secret plus authenticated case pre-registration and `notes.caseId` |
| PostgreSQL absent on Heroku | `REQUIRE_DATABASE`, readiness check, real persistence tests, human-gated Essential-0 provisioning |
| Manual-only expiry | Non-overlapping 60-second scheduler, maximum 100 cases per tick |
| Dashboard and README inaccuracies | Explicit runtime component labels, corrected Pincc routes, contrast fix, live link, honest video placeholder |
| Public release operations | Clean full-history secret scan before paid DB, deploy, visibility change, and issue closure |
| Unverified recurring charge | Disabled-by-default feature gate and ten-step Test Mode proof checklist; fallback link preserved |

## Compatibility with accepted decisions

ADR-0001 is strengthened: AI still recommends, policy still authorizes, and store coordination ensures concurrent callers cannot bypass the decision record. ADR-0002 is preserved: the deterministic simulator still owns reproducible evaluation, while live claims remain limited to Test Mode operations actually proven. The MVP's single-deployable constraint remains intact; the scheduler, lab runner, webhook ingress, and PostgreSQL adapter are modules inside the same process, not new services.
