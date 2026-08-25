# Recovery Loop

AI-assisted recovery for failed SaaS renewal payments. The AI recommends; deterministic policy authorizes.

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

Open `http://localhost:3000` for the local dashboard. Click **Run 60-case evaluation** to populate the simulator-backed demo.

Runtime configuration is documented in `.env.example`. Set `DATABASE_URL` to enable PostgreSQL persistence; without it, the app uses the in-memory adapter. The server initializes the schema from `src/persistence.sql`. Keep credentials outside the repository.

### Payment provider contract

`PaymentProvider` is the only payment seam the recovery workflow depends on: event verification, event normalization, retry eligibility, retry submission, and fallback-link creation. `tests/provider-contract.test.ts` runs the same suite against both the deterministic simulator and the Razorpay Test Mode adapter, so the two cannot drift.

Action identity is `RecoveryAction.idempotencyKey`. The simulator replays a recorded result for a repeated identity. The Razorpay adapter sends the key as the payment link's `reference_id`, so Razorpay itself rejects a duplicate; the adapter then resolves the existing link's real id through `GET /v1/payment_links?reference_id=...` and reports `idempotent: true`. Provider references are never synthesized — if the lookup fails, the result carries no reference and says so. Provider failures — outages, non-2xx responses, a created link with no id, missing credentials — map to a `failed` result rather than an exception.

Retry eligibility comes from the provider, not from the recommendation. Policy may approve a retry, but `authorize` asks the provider first; when the payment has no authorized recurring mandate it records a `retry_ineligible` audit event and asks policy again for the fallback link, which needs no mandate. Every executed action carries its own recorded policy decision, and a rejection escalates the case. The Razorpay adapter never claims it can recharge an arbitrary card payment.

### AI diagnosis

Set `ANTHROPIC_API_KEY` to use the model-backed diagnosis engine (`ANTHROPIC_MODEL` defaults to `claude-sonnet-5`, `DIAGNOSIS_TIMEOUT_MS` to 15000). Without the key, the app uses the deterministic fixture engine so the demo and the seeded evaluation stay reproducible.

The model receives only projected case signals — event ids, event types, timestamps, payment method, failure codes, amount, currency, and prior action counts. Raw provider payloads, card data, and provider credentials are never sent. Output is forced through the `record_diagnosis` tool and validated before use. An unsupported failure category, a confidence outside 0..1, missing evidence, evidence that cites no signal on the case, or a rejected request raises a terminal `DiagnosisUnavailableError` and the case is escalated to a human. A timeout, HTTP 429, HTTP 5xx, or transport error raises a retryable one: `runDiagnosis` re-attempts up to three times within the run and escalates if every attempt fails, so a case never stalls without a diagnosis. Attempts back off — honouring the provider's `retry-after` when present, otherwise 1s × attempt — through an injected `sleep` seam that tests replace with a no-op. Every failed attempt appends a `diagnosis_unavailable` audit event, and no money action occurs on any of these paths. A case with no diagnosis authorizes nothing.

An escalated or exhausted case can still transition to `recovered` if the customer pays, so recovered revenue reconciles honestly. No new recovery action is authorized from those states.

### Webhooks

`POST /webhooks/razorpay` accepts a signed JSON event. The handler verifies `x-razorpay-signature`, uses `x-razorpay-event-id` when the payload has no event id, deduplicates event delivery, and opens a case from renewal context on the first failed event. In local simulator mode, sign the raw body as `sim:<raw-body>`; with Razorpay credentials configured, use the HMAC-SHA256 signature generated with `RAZORPAY_KEY_SECRET`.

## Architecture

- `src/domain.ts`: Recovery Case types, lifecycle, immutable renewal context, and audit helpers.
- `src/recovery.ts`: application workflow seam, deterministic policy, store, and idempotent action execution.
- `src/diagnosis.ts`: diagnosis engine seam, structured-output validation, and the Anthropic Messages adapter.
- `src/provider.ts`: the payment-provider contract, the deterministic simulator, and the Razorpay Test Mode adapter.
- `src/evaluation.ts`: seeded 50+ case evaluation and reconciliation metrics.
- `src/http.ts`: the HTTP boundary — webhook ingestion, operator verdicts, dashboard, and projections.
- `src/server.ts`: process bootstrap that binds the HTTP boundary to a port.
- `src/persistence.sql`: PostgreSQL persistence foundation for productionizing the in-memory store.

The workflow accepts its clock, diagnosis engine, policy, store, and provider as dependencies. Tests exercise behavior at that seam rather than private implementation details.

### Webhook ingestion and ordering

Every delivery is verified, parsed, and persisted before orchestration runs: an unsigned body is rejected with `401` and never parsed, and a redelivered event id is stored once, adds no second payment attempt, and answers `200 {"duplicate": true}` instead of `202`.

Ordering is decided by what the case can prove, not by arrival time. A `payment_succeeded` is recovered revenue only when a retry or fallback link could have caused it — otherwise it is audited as `pre_existing_success`. Because money settles independently of the loop, a success is evaluated before any terminal guard, so a case that was escalated or exhausted while the payment was in flight still reconciles. Anything else arriving after an outcome is recorded as `late_event_ignored` and changes nothing.

### Bounded recovery orchestration

The ladder is one authorized recurring retry, then one expiring fallback link, then a terminal outcome. Policy is the only authorizer, and it re-checks the money-bearing facts on every call: the renewal context must still be intact (a case rehydrated from storage never passed through the aggregate's validation), a failed attempt must be on record, the renewal must not already be paid, and a still-live fallback link blocks any further action.

Actions are identified by `idempotencyKey` and stay `pending` until their result is stored, so a process that dies between the provider call and the write re-drives the same identity and the provider replays rather than charging again. `expireLapsedActions` retires a fallback link the customer never paid — nothing else closes a case resting in `fallback_link_available` — and is exposed as `POST /api/expire`. Operators can stop or escalate a live case through `POST /api/cases/:id/stop` and `/escalate`; against a case that already reached an outcome, both record `manual_action_ignored` rather than overwriting it.

## Synthetic evaluation

```bash
node --input-type=module -e "import('./dist/src/evaluation.js').then(async ({runEvaluation}) => console.log(await runEvaluation()))"
```

Synthetic results must not be presented as expected production performance. Razorpay credentials are optional and only used for a separately configured Test Mode integration.

## Documentation

- [MVP specification](docs/specs/recovery-loop-mvp.md)
- [Domain context](CONTEXT.md)
- [ADR-0001: AI recommends; deterministic policy authorizes](docs/adr/0001-ai-recommends-policy-authorizes.md)
- [ADR-0002: Provider contract with simulator-first evaluation](docs/adr/0002-provider-contract-and-simulator-first.md)
