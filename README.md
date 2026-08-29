# Recovery Loop

AI-assisted recovery for failed SaaS renewal payments. The AI recommends; deterministic policy authorizes.

**Live demo:** https://recovery-loop-ecd128e33dca.herokuapp.com/

**Demo video:** Recording deferred; no video URL is published yet.

## What is real, and what is simulated

The dashboard header names each of these at runtime, so nothing on screen reads as more live than
it is:

| Component | Public demo |
| --- | --- |
| Payments | Deterministic simulator. Razorpay Test Mode when credentials are configured. |
| Live diagnosis | Pincc when `PINCC_API_KEY` is set, otherwise the deterministic fixture engine. |
| Seeded 60-case evaluation | Always simulator payments and fixture diagnosis, so its figures reproduce. |
| Persistence | PostgreSQL when `DATABASE_URL` is attached; otherwise in-memory and non-durable. |
| Razorpay recurring retry | Disabled. The charge has never run against the account — see below. |
| Razorpay fallback link | Exercised for real against Test Mode. |

## MVP workflow

```text
failed renewal -> normalized event -> diagnosis -> policy gate
  -> one eligible recurring retry -> one expiring fallback link
  -> recovered, escalated, exhausted, or stopped
```

The MVP uses a deterministic simulator for reproducible synthetic evaluation and includes a Razorpay Test Mode provider seam. It does not move real money, retry arbitrary card payments, or send production customer messages.

## Development

Requirements: Node.js 22+.

```bash
npm install
npm run typecheck
npm test
npm run build
npm run dev
```

Open `http://localhost:3000` for the local dashboard. A cold instance publishes the seeded batch on
start, so the figures are there without pressing anything.

Runtime configuration is documented in `.env.example`. Set `DATABASE_URL` to enable PostgreSQL
persistence; without it the app uses the in-memory adapter, which loses every case on restart. A
deployment sets `REQUIRE_DATABASE=true` so a missing database is a startup failure rather than a
silent fall back. `GET /healthz` reports `{ ok, persistence }`. The server initializes the schema
from `src/persistence.sql`. Keep credentials outside the repository.

`tests/persistence.test.ts` and `tests/postgres-concurrency.test.ts` are the only suites that
exercise the PostgreSQL adapter — everything else runs against the in-memory one — so they are
skipped unless `TEST_DATABASE_URL` points at a database they may truncate. A disposable one:

```bash
docker run --name recovery-loop-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=recovery_loop_test -p 5432:5432 -d postgres:16
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/recovery_loop_test npm run test:postgres
```

On Heroku the durable store means `heroku-postgresql:essential-0`, which is a paid add-on. Nothing
in this repository provisions it; attaching it is a deliberate human decision.

### Who may change anything

Every state-changing route — case registration, stop, escalate, manual expiry, and republishing the
evaluation — requires `Authorization: Bearer $CONTROL_PLANE_TOKEN`. An instance with no token
configured answers `404` for those routes rather than `401`, because advertising a locked door is
still advertising. The token never reaches the browser, so the public page carries read-only
projections and the replay lab and nothing else.

The webhook is the one exception: it carries a provider HMAC of its own.

### Payment provider contract

`PaymentProvider` is the only payment seam the recovery workflow depends on: event verification, event normalization, retry eligibility, retry submission, and fallback-link creation. `tests/provider-contract.test.ts` runs the same suite against both the deterministic simulator and the Razorpay Test Mode adapter, so the two cannot drift.

Action identity is `RecoveryAction.idempotencyKey`. The simulator replays a recorded result for a repeated identity. The Razorpay adapter uses the key as a retry order's `receipt` and a payment link's `reference_id`, and writes the full key to `notes.recoveryActionKey`. Provider references are never synthesized. If a provider lookup fails, the result carries no reference and says so. Provider failures such as outages, non-2xx responses, an object with no id, or missing credentials map to a `failed` result rather than an exception.

### Razorpay Test Mode adapter

`RazorpayTestModeProvider` is the live integration behind that contract. It performs only operations Razorpay's public API documents:

- **Recurring retry.** It reads the original payment (`GET /v1/payments/:id`) and requires a complete mandate token, customer, email, contact, amount, and currency. An explicit negative `recurring` flag refuses the charge; the undocumented absence of that field does not. Before any POST, the provider customer, original order, amount, and currency must equal the registered case, and the subscription id in the payment or original-order notes must match. It then creates a new order (`POST /v1/orders`) whose `receipt` is the action identity and charges the mandate (`POST /v1/payments/create/recurring`) with those verified provider terms. The order and charge notes carry `caseId`, `subscriptionId`, and `recoveryActionKey`. The response only means *submitted*; the webhook decides the outcome.
- **Expiring fallback link.** `POST /v1/payment_links` with the action identity as `reference_id` and an `expire_by` 24 hours ahead of the injected clock.
- **Idempotency.** Before creating an order the adapter looks the receipt up (`GET /v1/orders?receipt=...`). It reuses the result only when its receipt, amount, currency, `caseId`, `subscriptionId`, and raw `recoveryActionKey` all match the verified action. When that action order already has any payment (`GET /v1/orders/:id/payments`), including `created` or `failed`, it returns that payment id with `idempotent: true` instead of charging again. This makes replay safe if the process dies after Razorpay accepts a charge but before the caller records its response. An existing action order with no payment is reused, which also covers a crash after order creation. A duplicate-order response is resolved through the same receipt lookup. An identity longer than Razorpay's 40-character limit is folded deterministically to a 31-character prefix plus a SHA-256 suffix. Razorpay does not document receipt uniqueness, so the initial lookup and create are not an atomic concurrency guarantee. A retry is refused once any attempt on the case has succeeded, and targets the latest failed mandate attempt, so a renewal that is already paid is never charged again.
- **Error mapping.** Non-2xx responses, transport failures, a missing payment id, and missing credentials all map to a `failed` result carrying Razorpay's own description — never an exception, never a synthesized provider reference.
- **Unsupported operations.** A case with no authorized recurring mandate fails with the reason instead of pretending an arbitrary card can be recharged.

**Test Mode only.** Every money operation refuses to run unless `RAZORPAY_KEY_ID` starts with `rzp_test_`, so live keys cannot move real money through this MVP.

#### Setup

1. In the Razorpay Dashboard, switch to **Test Mode** and generate API keys under *Account & Settings → API Keys*.
2. Export them at runtime — never commit them: `RAZORPAY_KEY_ID=rzp_test_...`, `RAZORPAY_KEY_SECRET=...`.
3. Add a webhook pointing at `POST /webhooks/razorpay` for `payment.failed`, `payment.captured`, `payment.authorized`, `subscription.cancelled`, and `dispute.created`. Razorpay signs webhooks with the **webhook secret**, which it issues separately from the API key secret: set it as `RAZORPAY_WEBHOOK_SECRET`. It is required whenever Razorpay credentials are present and is never substituted with the API secret — one leaked value must not both call the API and forge deliveries.
4. Run the optional live checks: `RAZORPAY_KEY_ID=rzp_test_... RAZORPAY_KEY_SECRET=... npm test`. `tests/razorpay-integration.test.ts` is skipped unless a Test Mode key is present; it creates a real Test Mode payment link and proves the replay path.

Charging a mandate end to end additionally requires a Test Mode customer with an authorized recurring token; without one the adapter reports the retry as unsupported rather than attempting it. The seeded evaluation never uses this adapter, so batch metrics stay reproducible.

#### Known deviations from Razorpay's documented recurring flow

These are deliberate, and named here rather than discovered later. `docs/research/razorpay-test-mode-mandate-setup.md` carries the sourced findings behind each.

- **A retry creates a new order rather than re-initiating the failed payment's own order.** Razorpay's create-subsequent-payment reference says to create a new order for every charge, while its recurring FAQ describes re-initiating a failed payment against the same order every 36 hours. The adapter follows the former and keys the new order on the recovery action, because replaying one action must never create another debit. This does not implement the FAQ's same-order retry operation, and the **36-hour spacing is not modelled anywhere in the adapter**. The MVP's one-retry-per-case bound limits attempts instead.
- **A missing `recurring` flag does not disqualify a payment.** `GET /v1/payments/:id` is not documented as returning `recurring` at all; it is documented on the token entity, and it is absent from Razorpay's own webhook payload samples, which do carry `token_id`. Treating absence as "not recurring" would refuse every real mandate payment and leave the retry path unreachable, so absence means unknown and `token_id` is what proves a mandate exists. A flag that is present is honoured as `true`, `'true'`, `'1'`, or `1`; only an explicit negative refuses the charge. See `mandateFlagAllows` in `src/provider.ts`.
- **The mandate-charge path has never run against Razorpay, and is disabled because of it.** `RAZORPAY_RECURRING_RETRY_ENABLED` defaults to `false`; while it is false, `retryEligibility` and `submitRetry` both refuse without a network call and policy steps the case down to the fallback link. `docs/research/razorpay-test-mode-mandate-setup.md` holds the ten-step Test Mode proof gate that would earn the flag, and `tests/razorpay-recurring-proof.test.ts` is the opt-in suite that proves it. Neither has been completed. Recurring payments are not enabled on the Test Mode account this was built with: `GET /v1/methods` reports `card` and `nach` but carries no `recurring` or `subscriptions` key, and both Standard Checkout and Razorpay's own hosted registration link refuse a correctly-created card-mandate order with "No appropriate payment method found". Enabling it requires a Razorpay support request. So `recurring: true` in the charge body matches Razorpay's documented type but is unverified live, and the fallback-link path is the only money operation this repo has exercised against the real API.

Both implementations decide retry eligibility through one exported rule, `chargeableMandateAttempt`, so the seam cannot drift: a case with a succeeded attempt is already paid and offers nothing to charge, and the target is the latest failed mandate attempt rather than the oldest. The shared contract suite covers that case against both providers, and asserts neither of them charges a case it reports as ineligible. The two differ on purpose in one place: the simulator resolves a retry terminally (`succeeded`/`failed`) so the seeded batch stays reproducible, while the adapter can only report `submitted` and lets the webhook decide.

Retry eligibility comes from the provider, not from the recommendation. Policy may approve a retry, but `authorize` asks the provider first; when the payment has no authorized recurring mandate it records a `retry_ineligible` audit event and asks policy again for the fallback link, which needs no mandate. Every executed action carries its own recorded policy decision, and a rejection escalates the case. The Razorpay adapter never claims it can recharge an arbitrary card payment.

### AI diagnosis

Set `PINCC_API_KEY` and `PINCC_MODEL` to use Pincc's gateway for live diagnosis. `PINCC_BASE_URL` defaults to `https://v2.pincc.ai`, and the route depends on the model id: a `claude-` model uses `${PINCC_BASE_URL}/v1/messages` with Anthropic's Messages contract, and any other model id uses `${PINCC_BASE_URL}/v1/chat/completions` with the OpenAI-compatible contract. Both force the `record_diagnosis` schema. Live diagnosis applies to cases the loop drives; the seeded batch always uses fixtures, so its figures reproduce. If Pincc is not configured, `ANTHROPIC_API_KEY` keeps the direct Anthropic Messages adapter available (`ANTHROPIC_MODEL` defaults to `claude-sonnet-5`). Without either credential, the app uses the deterministic fixture engine. `DIAGNOSIS_TIMEOUT_MS` defaults to 15000.

When both Pincc and Anthropic credentials are configured, Pincc takes precedence. The seeded evaluation always uses fixtures, so gateway choice never changes the published batch metrics.

The model receives only projected case signals — event ids, event types, timestamps, payment method, failure codes, amount, currency, and prior action counts. Raw provider payloads, card data, and provider credentials are never sent. Output is forced through the `record_diagnosis` tool and validated before use. An unsupported failure category, a confidence outside 0..1, missing evidence, evidence that cites no signal on the case, or a rejected request raises a terminal `DiagnosisUnavailableError` and the case is escalated to a human. A timeout, HTTP 429, HTTP 5xx, or transport error raises a retryable one: `runDiagnosis` re-attempts up to three times within the run and escalates if every attempt fails, so a case never stalls without a diagnosis. Attempts back off — honouring the provider's `retry-after` when present, otherwise 1s × attempt — through an injected `sleep` seam that tests replace with a no-op. Every failed attempt appends a `diagnosis_unavailable` audit event, and no money action occurs on any of these paths. A case with no diagnosis authorizes nothing.

An escalated or exhausted case can still transition to `recovered` if the customer pays, so recovered revenue reconciles honestly. No new recovery action is authorized from those states.

### Webhooks

`POST /webhooks/razorpay` accepts a signed JSON event. The handler verifies `x-razorpay-signature` before parsing anything, uses `x-razorpay-event-id` when the payload has no event id, and deduplicates delivery. Both providers verify an HMAC-SHA256 hex digest of the raw body: Razorpay's uses `RAZORPAY_WEBHOOK_SECRET`, and the simulator's uses `SIMULATOR_WEBHOOK_SECRET`, which defaults to random bytes generated per process so no outside caller can sign a delivery an unconfigured instance would accept.

A delivery cannot open a case. Renewal context is merchant data, so it is registered first through the authenticated `POST /api/recovery-cases` with `{ id, context }`; the delivery then names that case through an explicit `caseId` or Razorpay's `notes.caseId`. Registration is idempotent, and a different renewal under an id already in use is a `409`.

## Architecture

```mermaid
flowchart TD
  W[Razorpay webhook] -->|verify signature, dedupe| H[HTTP boundary<br/>src/http.ts]
  H -->|normalized event| WF[Recovery workflow<br/>src/recovery.ts]
  WF -->|case signals, no credentials| D[Diagnosis engine<br/>src/diagnosis.ts]
  D -->|structured recommendation| WF
  WF -->|recommendation + case facts| P[Deterministic policy<br/>src/recovery.ts]
  P -->|authorized action only| WF
  WF -->|retry / fallback link| PR[Payment provider contract<br/>src/provider.ts]
  PR --> SIM[Deterministic simulator]
  PR --> RZP[Razorpay Test Mode]
  WF -->|case, events, decisions, actions, audit| ST[(Store<br/>in-memory or PostgreSQL)]
  E[Seeded evaluation<br/>src/evaluation.ts] -->|drives the same workflow| WF
  ST --> H
  H -->|projections| UI[Merchant dashboard]
```

The HTTP boundary uses the provider to verify and normalize a delivery, but every money-moving operation is reached only through the workflow after policy authorized it — and the diagnosis engine has no path to `src/provider.ts` at all, which is what ADR-0001 makes structural rather than procedural.

- `src/domain.ts`: Recovery Case types, lifecycle, immutable renewal context, and audit helpers.
- `src/recovery.ts`: application workflow seam, deterministic policy, store, and idempotent action execution.
- `src/diagnosis.ts`: diagnosis engine seam, structured-output validation, and Pincc/OpenAI-compatible plus Anthropic transport adapters.
- `src/provider.ts`: the payment-provider contract, the deterministic simulator, and the Razorpay Test Mode adapter.
- `src/evaluation.ts`: the seeded 50+ case dataset, the batch runner, and reconciliation metrics.
- `src/messaging.ts`: the customer-facing fallback message preview, with no delivery integration.
- `src/http.ts`: the HTTP boundary — webhook ingestion, operator verdicts, dashboard, and projections.
- `src/server.ts`: process bootstrap that binds the HTTP boundary to a port.
- `src/persistence.ts` and `src/persistence.sql`: the PostgreSQL adapter for the case store and published evaluation runs, and the schema it initializes.

The workflow accepts its clock, diagnosis engine, policy, store, and provider as dependencies. Tests exercise behavior at that seam rather than private implementation details.

### Webhook ingestion and ordering

Every delivery is verified, parsed, and persisted before orchestration runs: an unsigned body is rejected with `401` and never parsed, and a redelivered event id is stored once, adds no second payment attempt, and answers `200 {"duplicate": true}` instead of `202`.

Ordering is decided by what the case can prove, not by arrival time. A `payment_succeeded` is recovered revenue only when a retry or fallback link could have caused it; when nothing did, the renewal was paid outside the loop, so the case is audited as `pre_existing_success` and stood down to `stopped` — retrying a paid renewal would collect it twice. Because money settles independently of the loop, a success is evaluated before any terminal guard, so a case that was escalated or exhausted while the payment was in flight still reconciles.

A `payment_failed` that arrives while a retry is outstanding is that retry's real outcome, since the Razorpay adapter only reports `submitted` at call time: the action is marked failed and the case steps down to the fallback rung. Anything else arriving after an outcome is recorded as `late_event_ignored` and changes nothing. Every outcome — recovered, escalated, exhausted, stopped — appends its own `case_*` audit event.

### Bounded recovery orchestration

The ladder is one authorized recurring retry, then one expiring fallback link, then a terminal outcome. Policy is the only authorizer, and it re-checks the money-bearing facts on every call: the renewal context must still be intact (a case rehydrated from storage never passed through the aggregate's validation), a failed attempt must be on record, the renewal must not already be paid, and a still-live fallback link blocks any further action.

`workflow.drive(caseId)` carries a case to its next resting point — diagnose if it has no recommendation, ask policy, execute what policy authorized — and is what the webhook calls once an event is safely persisted. A case resting on a submitted retry or a live link is waiting on the outside world, so `drive` leaves it alone rather than asking policy for a rung it has already spent. Nothing sequences those three steps outside the workflow.

Actions are identified by `idempotencyKey` and stay `pending` until their result is stored, so a process that dies between the provider call and the write re-drives the same identity and the provider replays rather than charging again. `expireLapsedFallbackLink` retires a link the customer never paid — nothing else closes a case resting in `fallback_link_available`. A scheduler sweeps at boot and every 60 seconds while the server listens, taking at most 100 due cases per tick and skipping a tick that would overlap a running sweep. The authenticated `POST /api/expire` runs the same bounded sweep for operational verification; it is not the mechanism. Operators can stop or escalate a live case through `POST /api/cases/:id/stop` and `/escalate`; against a case that already reached an outcome, both record `manual_action_ignored` rather than overwriting it.

### Merchant dashboard and projections

The dashboard at `/` is served from the HTTP boundary and reads these projections, so anything it shows an operator is also available to a script:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/metrics` | The live projection over every stored case — revenue at risk (renewals still in play: a case that reached any terminal outcome no longer counts), recovered amount, recovery rate, escalated, exhausted — plus `batch`, the last published run's own reconciled figures and versions. A published batch reports *beside* the live figures, never instead of them: runs are durable, so a batch that shadowed the live projection would shadow it permanently. Every figure in this MVP is synthetic and labelled so. |
| `GET /api/cases?status=` | The case list. An unknown status is a `400` rather than a silently empty list; the vocabulary comes from the aggregate's transition table. |
| `GET /api/cases/:id` | One case in full: renewal context, diagnosis with its evidence and confidence, every policy decision and its reason, actions, attempts, events, the append-only audit timeline, and — as `fallbackMessage` — the customer message for a live fallback link, previewed as it would be sent. |
| `GET /api/evaluation` | Replays the last published batch — ground-truth safe action and outcome beside what the loop actually did. Only an authenticated `POST` publishes a new one. |
| `GET /api/runtime` | Which payments, diagnosis, persistence, and recurring-retry configuration this instance is actually running, in the words the dashboard header shows. |
| `GET /healthz` | `{ ok, persistence }` after the store answers. A failure is a generic `503`; the driver's own error, which names the host and often the credentials, goes to the logs. |
| `POST /api/lab/replay` | Replays one named webhook scenario inside a throwaway application — its own store, its own simulator secret, fixture diagnosis. Public, because it can reach nothing: no signature or raw body is returned, and no canonical figure moves. |

The fallback message preview is a preview and nothing more: `deliverable` is always `false`, no email, SMS, WhatsApp, or voice provider is integrated, and no send happens anywhere in the MVP. It names the renewal, the unchanged amount and currency, and the provider's own link reference — never a synthesized URL, a provider payment id, or gateway failure telemetry. It offers nothing once any payment attempt has succeeded or the case has reached an outcome, which covers a renewal paid outside the loop: that case stands down to `stopped` without ever reaching `recovered`, and asking its customer to pay the link would collect the renewal twice. The link it previews is the one `fallbackLinkState` calls live — the same rule policy and the expiry sweep use — and a lapsed link is marked `expired` rather than previewed as usable.

A published batch is stored through `EvaluationRunStore`, so a restart shows a merchant the same figures rather than quietly replacing them with a live projection. The public page carries no operator controls at all: stopping, escalating, expiring, and republishing are control-plane calls, and putting a bearer token in browser JavaScript would simply publish it.

## Synthetic evaluation

```bash
node --input-type=module -e "import('./dist/src/evaluation.js').then(async ({runEvaluation}) => console.log((await runEvaluation()).metrics))"
```

`generateEvaluationCases(count, seed)` builds a seeded batch of 60 cases cycling 14 scenario archetypes: transient retry recovery, duplicate success delivery, delayed and contradictory events after settlement, retry failure into fallback recovery, a lapsed fallback link, an unavailable fallback link, a late success after both rungs were spent, hard decline, low confidence, unusable diagnosis output, an ineligible payment method that steps down a rung, a renewal paid outside the loop, a cancelled subscription, and a failure the provider mislabelled as temporary.

Each case carries ground truth — the real failure category, the action that was safe given that truth, whether it should recover revenue, and the expected outcome — beside the case rather than inside it. The workflow reads only the scripted provider deliveries, and every provider operation goes through `RecoveryWorkflow`, so the batch measures the loop the product ships. `diagnosisAccuracy` scores whichever `DiagnosisEngine` the run is given (the default predicts from the provider failure code alone, and the mislabelled archetype is one it gets wrong on purpose). `safeActionMismatches` counts the cases where the loop spent a rung ground truth calls unsafe — it may only do so when a misleading provider signal misled the diagnosis, which is what the mislabelled archetype proves.

`runEvaluation` gives every case its own store, simulator, and `FixedClock` seeded from `startedAt`, so link expiry and event ordering are deterministic and repeated runs of a seed publish identical totals. The report is `{ metrics, results }`. `metrics` is labelled `synthetic` and records the seed, dataset version, policy version, and diagnosis model version alongside failed renewal value, recovered and unrecovered amount, recovery rate, retry and fallback recovery, escalation, exhaustion, stopped cases, diagnosis accuracy, and the unsafe actions, refused recommendations, duplicate actions, duplicate deliveries, and late deliveries prevented. `unsafeActionsPrevented` counts only charges deterministic policy refused, which is 0 at seed 42 — an honest zero, because this batch contains no case where policy had to stop a proposed charge. The two figures that used to be folded into it are reported on their own: `recommendationsRefused` (8) is policy refusing a recommendation that proposed no charge, where agreeing with a diagnosis that asked for escalation prevented nothing, and `providerIneligibleRetries` (4) is the provider reporting no chargeable mandate, after which the loop steps down a rung and the customer may still be charged through the fallback link. Neither is a charge that was stopped. `results` holds one row per case with its Recovery Case, so every published total reconciles to individual case outcomes and their audit trails — every recovered case names the action that earned it in `recoveryAttribution`, including a fallback link the customer paid after it had lapsed, so no recovered rupee is reported without an owner.

`POST /api/evaluation` runs the same batch, publishes the run through `EvaluationRunStore`, and persists the Recovery Cases it drove — so the batch's cases are part of the live projection rather than a parallel set of numbers, and the run keeps the ground-truth scoring only a seeded batch can know: diagnosis accuracy, unsafe actions and duplicate actions prevented, and each case's expected safe action and outcome. A published run survives a restart; `GET /api/evaluation` replays it without re-running the batch. This MVP has a single synthetic merchant, so seeded cases are the merchant's cases — nothing distinguishes a demo case from a live one, and nothing needs to.

Synthetic results must not be presented as expected production performance. Razorpay credentials are optional and only used for a separately configured Test Mode integration.

## Deployment

The public demo runs on Heroku. `Procfile` names the web process; Heroku runs `npm run build`
automatically because the package defines a build script. `engines.node` is pinned to `22.x` so a
deploy cannot silently move to a Node major nothing here has been tested against.

The instance runs without Razorpay credentials on purpose: without them the app uses the
deterministic simulator, which is what the published batch figures are built on. The replay lab
builds its own isolated simulator, so it stays available on a credentialled instance too and can
never aim a synthetic delivery at a real payment integration.

A durable deployment attaches PostgreSQL and sets `REQUIRE_DATABASE=true`, so a missing database is
a startup failure rather than an instance that keeps answering while losing every case on restart.
On Heroku that means `heroku-postgresql:essential-0`, a paid add-on nothing here provisions.
`CONTROL_PLANE_TOKEN` enables the state-changing routes; without it they do not exist.

`PINCC_API_KEY` is optional and requires `PINCC_MODEL`; when set, live cases use Pincc. `ANTHROPIC_API_KEY`
remains a fallback. The seeded batch always uses fixtures, so gateway credentials never change its metrics.

`render.yaml` is kept as a working alternative host definition, not the deployed target.

## Documentation

- [MVP specification](docs/specs/recovery-loop-mvp.md)
- [Domain context](CONTEXT.md)
- [ADR-0001: AI recommends; deterministic policy authorizes](docs/adr/0001-ai-recommends-policy-authorizes.md)
- [ADR-0002: Provider contract with simulator-first evaluation](docs/adr/0002-provider-contract-and-simulator-first.md)
