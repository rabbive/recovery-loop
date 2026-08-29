<div align="center">

# Recovery Loop

<p><strong>AI-assisted revenue recovery for failed SaaS renewals.<br>The model recommends. Deterministic policy authorizes. Every outcome is auditable.</strong></p>

[![CI](https://github.com/rabbive/recovery-loop/actions/workflows/ci.yml/badge.svg)](https://github.com/rabbive/recovery-loop/actions/workflows/ci.yml)
[![Node.js 22](https://img.shields.io/badge/Node.js-%3E%3D22.12%20%3C23-339933?logo=node.js&logoColor=white)](package.json)
[![Live demo](https://img.shields.io/badge/demo-live-0f766e)](https://recovery-loop-ecd128e33dca.herokuapp.com/)

[Live demo](https://recovery-loop-ecd128e33dca.herokuapp.com/) · [MVP specification](docs/specs/recovery-loop-mvp.md) · [Architecture decisions](docs/adr/)

</div>

![Recovery Loop turns a failed renewal into an AI diagnosis, a deterministic policy decision, one bounded recovery action, and an auditable outcome.](docs/assets/recovery-loop.svg)

<p align="center"><a href="docs/assets/recovery-loop.excalidraw">Edit the Excalidraw source</a></p>

Recovery Loop turns a failed renewal into an explainable, bounded recovery process. It normalizes signed payment events, produces a structured AI diagnosis, applies deterministic safety rules, executes only an authorized action, and reconciles the outcome to the original renewal.

It targets the **AI Revenue Recovery** track of the Razorpay AI Buildathon 2026.

## Proof, not promises

The published evaluation runs the shipped workflow against a deterministic seed-42 batch.

| Result | Verified value |
| --- | ---: |
| Failed renewals evaluated | 60 |
| Synthetic recovered revenue | ₹14,56,154 |
| Recovery rate | 46.7% |
| Retry recovery rate | 25.0% |
| Fallback-link recovery rate | 21.7% |
| Diagnosis accuracy | 91.7% |
| Duplicate actions prevented | 17 |

These figures are synthetic and reproducible. They are not a forecast of production recovery performance. Each total reconciles to a case, an approved action, a provider reference, and an audit trail.

## Why it is different

- **Closed loop.** The system diagnoses, decides, acts, observes the provider result, and updates measured revenue.
- **AI cannot move money.** The diagnosis model has no provider credentials. Deterministic policy is the sole action authority.
- **Bounded recovery.** A case can receive at most one eligible retry and one expiring fallback link.
- **Explicit attribution.** A payment counts as recovered only when provider identity, action identity, policy approval, and event time agree.
- **Reproducible evaluation.** The same 60 cases cover duplicates, delayed events, contradictory events, hard declines, expiry, recovery, and escalation.
- **Inspectable evidence.** The dashboard exposes diagnosis evidence, policy reasons, provider actions, and the append-only timeline.

## How the loop works

1. A signed provider webhook is verified, normalized, persisted, and deduplicated.
2. The diagnosis engine returns a category, confidence, evidence references, and a recommended action.
3. Deterministic policy checks immutable renewal context, confidence, retry eligibility, action limits, expiry, and terminal states.
4. An approved action runs through the payment-provider contract with a stable idempotency identity.
5. Provider success counts only when it correlates to that approved action. PostgreSQL stores the case, decisions, actions, outcomes, and evaluation run.

## Safety model

| Boundary | Guarantee |
| --- | --- |
| Diagnosis | Receives projected failure signals, no payment credentials, and cannot call the provider. |
| Policy | Authorizes every provider side effect and records the reason. |
| Provider | Refuses non-Test-Mode Razorpay keys and maps uncertainty to a failed result. |
| Idempotency | Uses one stable identity per action across the workflow and its provider resource. |
| Ordering | Duplicate and late events cannot reopen a settled case or spend another action. |
| Control plane | State-changing routes require a bearer token that never reaches browser code. |
| Persistence | The deployed app requires PostgreSQL and exposes storage health at `GET /healthz`. |

## What is live

| Component | Status |
| --- | --- |
| Dashboard and API | Live on Heroku |
| Diagnosis | Pincc, with a fixture fallback for unconfigured local runs |
| Persistence | PostgreSQL |
| Seeded evaluation | Deterministic simulator and fixture diagnosis |
| Razorpay fallback link | Exercised against Test Mode |
| Razorpay recurring retry | Disabled until the account completes the live mandate proof |

The public replay lab sends fixed signed scenarios through the real webhook boundary in an isolated store. It demonstrates duplicate delivery, ordering, and signature rejection without changing canonical metrics.

## Run locally

Requirements: Node.js `>=22.12.0 <23`.

```bash
npm ci
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). A cold instance publishes the seeded batch automatically.

The default local store is in memory. For durable PostgreSQL verification:

```bash
docker run --name recovery-loop-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=recovery_loop_test \
  -p 5432:5432 \
  -d postgres:16

TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/recovery_loop_test \
  npm run test:postgres
```

Runtime configuration is documented in [`.env.example`](.env.example). Credentials stay outside the repository.

## Verify it

```bash
npm run typecheck
npm test
npm run build
```

The full CI suite runs PostgreSQL 16. Credential-gated Razorpay suites remain skipped unless Test Mode inputs are supplied.

## Project map

| Module | Responsibility |
| --- | --- |
| [`src/recovery.ts`](src/recovery.ts) | Workflow, policy, locking, idempotent action execution |
| [`src/diagnosis.ts`](src/diagnosis.ts) | Structured AI diagnosis and fail-safe validation |
| [`src/provider.ts`](src/provider.ts) | Simulator and Razorpay Test Mode adapters |
| [`src/webhook.ts`](src/webhook.ts) | Signature verification, normalization, canonical ingress |
| [`src/evaluation.ts`](src/evaluation.ts) | Seeded 60-case batch and reconciled metrics |
| [`src/persistence.ts`](src/persistence.ts) | PostgreSQL case and evaluation storage |
| [`src/http.ts`](src/http.ts) | Dashboard, projections, replay lab, control-plane routes |

## Read the design

- [MVP specification](docs/specs/recovery-loop-mvp.md)
- [Domain context and invariants](CONTEXT.md)
- [ADR 0001: AI recommends; deterministic policy authorizes](docs/adr/0001-ai-recommends-policy-authorizes.md)
- [ADR 0002: Provider contract with simulator-first evaluation](docs/adr/0002-provider-contract-and-simulator-first.md)
- [Razorpay Test Mode mandate research](docs/research/razorpay-test-mode-mandate-setup.md)
- [Release-hardening plan](docs/superpowers/plans/2026-08-29-release-hardening.md)

## Current limitation

The account used for the demo cannot register a recurring card mandate in Razorpay Test Mode, so automatic recurring retry remains disabled. The fallback payment-link path is live-proven. [Issue #22](https://github.com/rabbive/recovery-loop/issues/22) records the attempted mandate flows, evidence, and proof gate.

---

Built as one deployable TypeScript application for Razorpay AI Buildathon 2026. No real money, arbitrary card retries, or production customer messaging.
