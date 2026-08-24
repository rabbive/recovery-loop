# Recovery Loop MVP Specification

**Track:** Razorpay AI Buildathon — AI Revenue Recovery  
**Status:** Ready for implementation

## Problem Statement

Subscription SaaS merchants lose recurring revenue when renewal payments fail. Razorpay exposes the payment primitives and events, but a merchant still has to interpret fragmented failure signals, decide whether another attempt is safe, choose a compliant fallback, avoid duplicate charges, and prove how much revenue the intervention recovered.

Recovery teams need a closed loop that turns a failed renewal into an explainable diagnosis, a bounded action, and a measured outcome. The solution must work across a batch rather than a cherry-picked payment, and every money-related action must be gated, idempotent, and auditable.

## Solution

Build Recovery Loop, an AI-assisted recovery service for failed SaaS renewal payments. It ingests Razorpay-compatible payment events, opens a Recovery Case, uses AI to produce a structured diagnosis and suggested intervention, and passes that suggestion through deterministic policy before anything is executed.

The MVP supports one narrow workflow: one authorized recurring-payment retry when the case is eligible, followed by one expiring fallback payment link if the retry does not recover the payment. Cases that are unsafe, ambiguous, exhausted, or low-confidence are escalated to a human. Success immediately stops all pending recovery work.

A merchant dashboard shows revenue at risk, recovered revenue, case status, the explanation behind every recommendation, policy decisions, blocked unsafe actions, and a complete audit timeline. A deterministic simulator evaluates at least 50 synthetic failed renewals, while a Razorpay Test Mode adapter demonstrates the integration path without moving real money.

## User Stories

1. As a SaaS merchant, I want failed renewal payments collected into Recovery Cases, so that revenue at risk is visible in one place.
2. As a SaaS merchant, I want to see the total value of failed renewals, so that I understand the size of the recovery opportunity.
3. As a recovery operator, I want each case to preserve its customer, subscription, order, amount, currency, and payment-attempt relationships, so that I can trust the context.
4. As a recovery operator, I want duplicate webhook deliveries deduplicated, so that one event cannot trigger repeated actions.
5. As a recovery operator, I want out-of-order events handled safely, so that a late failure cannot override a later success.
6. As a recovery operator, I want invalid webhook signatures rejected, so that untrusted events cannot initiate recovery.
7. As a recovery operator, I want the agent to diagnose the likely failure category, so that I do not interpret raw gateway telemetry manually.
8. As a recovery operator, I want the diagnosis to cite the signals it used, so that I can understand its reasoning.
9. As a recovery operator, I want a confidence score attached to the diagnosis, so that uncertain cases can be escalated.
10. As a recovery operator, I want the agent to recommend the next-best intervention, so that recovery decisions are consistent.
11. As a merchant, I want deterministic policy to authorize or reject every recommendation, so that AI cannot move money by itself.
12. As a merchant, I want retries limited to eligible authorized recurring-payment attempts, so that arbitrary card charges cannot be retried server-side.
13. As a merchant, I want at most one retry per Recovery Case, so that customers are not charged repeatedly.
14. As a merchant, I want retries to preserve the original customer, subscription, amount, and currency, so that recovery cannot alter the purchase.
15. As a merchant, I want every provider operation to use an idempotency key, so that infrastructure retries cannot duplicate money actions.
16. As a customer, I want a fallback payment link after an unsuccessful eligible retry, so that I can complete the renewal using a supported method.
17. As a customer, I want the fallback link to expire, so that stale recovery requests cannot remain valid indefinitely.
18. As a customer, I want no further recovery actions after payment succeeds, so that I am not contacted or charged again.
19. As a recovery operator, I want hard declines, cancelled subscriptions, disputes, expired cases, and policy violations escalated or stopped, so that unsafe recovery is prevented.
20. As a recovery operator, I want low-confidence AI outputs escalated, so that uncertain automation fails safely.
21. As a recovery operator, I want malformed or unavailable AI output to result in no execution, so that model failure cannot cause a money action.
22. As a recovery operator, I want to see why policy allowed or blocked an action, so that deterministic safeguards are explainable.
23. As a recovery operator, I want an append-only timeline of received events, diagnoses, decisions, provider requests, provider responses, and outcomes, so that every case is auditable.
24. As a recovery operator, I want to manually stop or escalate a case, so that a human can retain control.
25. As a merchant, I want recovered revenue counted only when a successful payment is correlated with the original Recovery Case and a recovery action, so that the metric is honest.
26. As a merchant, I want first-attempt recoveries, fallback-link recoveries, escalations, exhausted cases, and prevented unsafe actions reported separately, so that I can evaluate the workflow.
27. As a merchant, I want recovery rate and recovered amount reported across at least 50 cases, so that the result is not based on one successful demo.
28. As an evaluator, I want a reproducible synthetic dataset with known expected outcomes, so that the claims can be verified.
29. As an evaluator, I want the simulator to include duplicate, delayed, and contradictory events, so that reliability is demonstrated rather than asserted.
30. As an evaluator, I want to inspect one case from failure through recovery, so that the end-to-end behavior is clear in the demo.
31. As a developer, I want payment-provider behavior behind a stable contract, so that the deterministic simulator and Razorpay Test Mode use the same recovery workflow.
32. As a developer, I want replayable fixtures and a controllable clock, so that expiry, retry windows, and ordering behavior can be tested deterministically.
33. As a developer, I want model and policy versions recorded with each decision, so that evaluation results remain reproducible.
34. As a developer, I want secrets supplied only through runtime configuration, so that Razorpay and model credentials are not stored in the repository.
35. As a solo builder, I want the product implemented as one deployable TypeScript application, so that the 11-day scope remains manageable.

## Implementation Decisions

1. **Narrow domain:** The MVP targets failed recurring renewal payments for one synthetic SaaS merchant. Checkout abandonment, receivables, and unrelated payment-loss scenarios are excluded.
2. **Recovery Case aggregate:** A Recovery Case owns the original renewal context, normalized provider events, diagnoses, policy decisions, recovery actions, outcome, and audit timeline.
3. **Case lifecycle:** Cases move through `at_risk`, `diagnosed`, `retry_scheduled`, `fallback_link_available`, `recovered`, `escalated`, or `exhausted`. Terminal success prevents all later actions. Invalid transitions are rejected and audited.
4. **Webhook-first ingestion:** Provider webhooks are authenticated, normalized, persisted, and deduplicated before orchestration. Provider event identity and case state, rather than delivery order, determine whether an event may change the case.
5. **AI is advisory:** The model emits structured output containing a failure category, confidence, evidence references, recommended action, and explanation. It has no provider credentials and cannot invoke payment operations.
6. **Deterministic policy is authoritative:** Policy validates case state, confidence threshold, retry eligibility, amount and currency integrity, customer/subscription identity, attempt counts, expiry, and stop conditions. A rejected recommendation creates an audit event but no side effect.
7. **Bounded action sequence:** An eligible case may receive at most one authorized recurring-payment retry and one fallback payment link. A second failed path escalates or exhausts the case. Hard declines and ineligible payment methods skip retry.
8. **Technically honest retry semantics:** The live integration will not claim that arbitrary card payments can be retried automatically. Retry execution is limited to provider-supported recurring/mandate behavior; deterministic fixtures simulate the batch. Razorpay Test Mode demonstrates only operations supported by its public API.
9. **Provider boundary:** Recovery orchestration depends on a small payment-provider contract for retry eligibility, retry submission, fallback-link creation, event verification, and result lookup. A deterministic simulator and a Razorpay Test Mode adapter implement that same contract.
10. **Reliable side effects:** State changes and intended provider actions are recorded atomically. An idempotent action executor performs pending provider operations and records their outcomes, allowing safe process retries without duplicate actions.
11. **Persistent model:** PostgreSQL stores Recovery Cases, normalized events, action intents, provider results, audit events, policy/model versions, and aggregate evaluation runs.
12. **Single deployable application:** The MVP uses TypeScript for the dashboard, application API, orchestration worker, simulator, and provider adapters. Internal modules remain separated by domain responsibility without creating independently deployed services.
13. **Dashboard:** The UI provides an overview of revenue at risk and recovered revenue, a filterable case list, a detailed audit timeline, diagnosis evidence, policy explanations, and evaluation-run results.
14. **Synthetic evaluation:** A seeded generator produces at least 50 cases covering retryable transient failures, hard declines, asynchronous outcomes, successful fallbacks, duplicate events, out-of-order events, and already-recovered payments. Expected safe action and outcome are recorded separately from runtime predictions.
15. **Metrics:** The evaluation reports total revenue at risk, recovered amount, case recovery rate, retry recovery rate, fallback-link recovery rate, escalation rate, exhausted rate, diagnostic accuracy, and unsafe/duplicate actions prevented.
16. **Recovered-revenue attribution:** Revenue counts as recovered only when a provider success is correlated to the original case and occurs after an approved recovery action. Unrelated or pre-existing success events are excluded.
17. **Fail-safe behavior:** Model timeout, malformed structured output, unsupported diagnosis, provider uncertainty, or inconsistent case data produces no money action and routes the case to escalation.
18. **Auditability:** Audit events are append-only from the application’s perspective and include timestamps, actor, inputs or evidence references, decision, explanation, relevant versions, idempotency identity, and result.
19. **Time as an explicit dependency:** Retry windows, payment-link expiry, and case expiry use a controllable application clock so tests and simulations are deterministic.
20. **Demo mode:** The demo can run end to end without external credentials using the simulator. When credentials are available, a separately configured Razorpay Test Mode flow proves the real adapter without affecting the reproducible batch metrics.
21. **Customer communication boundary:** The MVP creates and previews the fallback recovery message/link but does not integrate a production email, SMS, WhatsApp, or voice provider.
22. **Secrets and sensitive data:** Credentials remain in environment configuration. Synthetic customers use non-sensitive identifiers; logs and AI prompts exclude payment credentials and unnecessary personal data.

## Testing Decisions

1. **Primary seam:** Test the complete Recovery Case workflow at the application boundary by providing normalized payment events, policy, clock, AI diagnosis result, and payment-provider behavior, then asserting observable case state, emitted provider action, metrics, and audit records. This is the highest useful seam and avoids testing internal helper functions.
2. **Behavior over implementation:** Tests assert externally visible outcomes and invariants, not private method calls, SQL shape, prompt wording, or component internals.
3. **Table-driven recovery scenarios:** Cover transient retry success, retry failure followed by fallback success, hard decline escalation, low-confidence escalation, malformed AI output, expired case, cancelled subscription, pre-existing success, and complete exhaustion.
4. **Idempotency and ordering:** Replay identical events and action requests; deliver failure/success events in multiple orders; prove that final state, provider action count, and recovered-revenue attribution remain correct.
5. **Safety properties:** Across generated event sequences, assert no case receives more than one retry or one fallback link, no action changes immutable payment context, and no action occurs after a terminal state.
6. **Provider contract tests:** Run shared contract tests against the simulator and Razorpay Test Mode adapter for event normalization, idempotent action identity, error mapping, and supported operations.
7. **Webhook boundary tests:** Verify valid signatures are accepted, invalid signatures are rejected, event identities are deduplicated, and unsupported events are safely recorded or ignored.
8. **AI contract tests:** Validate structured output parsing, evidence references, confidence thresholds, version recording, and fail-safe behavior. Do not assert natural-language phrasing.
9. **Evaluation acceptance test:** Execute the seeded 50+ case batch and assert the published totals are reproducible and reconcile to individual case outcomes.
10. **Dashboard acceptance tests:** Exercise the primary demo path: view revenue at risk, open a case, inspect diagnosis and policy decision, advance a simulated result, and observe recovered metrics and audit events update.
11. **Prior art:** The repository has no implementation or existing test conventions. This spec establishes the application workflow seam as the project’s testing precedent.

## Out of Scope

- Agentic-commerce protocol support, including AP2, ACP, UAP, or x402.
- Autonomous AI authority to retry, charge, refund, alter amounts, or bypass policy.
- Production or real-money Razorpay transactions.
- Automatic retry of arbitrary card payments without an authorized recurring mandate.
- Multiple merchants, currencies, payment providers, or tenant administration.
- Checkout abandonment, overdue invoices, B2B receivables, chargebacks, refunds, and fraud scoring.
- Production customer messaging through email, SMS, WhatsApp, or voice.
- Learning from real customer data or claiming production recovery performance from synthetic results.
- Full PCI DSS, legal, regulatory, consent, or production-readiness certification.
- Predictive payment routing, pricing incentives, discounts, or amount modification.
- Native mobile applications.

## Further Notes

- The product should be positioned as an intelligence and control layer over Razorpay’s documented payment primitives, not as evidence that Razorpay lacks recovery capabilities.
- The central demo claim is: “Recovery Loop recovered ₹X from a reproducible batch of failed renewals while preventing duplicate and unsafe recovery actions.”
- The intended demo sequence is: run the seeded batch, inspect aggregate revenue at risk, open one failed renewal, view the AI diagnosis, observe policy approve one retry, simulate retry failure, create an expiring fallback link, simulate success, and verify recovered revenue plus the audit trail.
- Suggested 11-day allocation: two days for the domain model and simulator, two for diagnosis and policy, two for orchestration/provider integration, two for the dashboard, one for batch evaluation and edge cases, and two for hardening, README, architecture diagram, pitch, and video.
- A useful stretch goal is a webhook replay/contract-lab view, but only after the complete recovery workflow and evaluation are reliable.
