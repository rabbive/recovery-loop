# Recovery Loop Domain Context

## Purpose

Recovery Loop is an AI-assisted control layer for recovering failed SaaS renewal payments. It turns payment-provider events into explainable diagnoses, deterministic policy decisions, bounded recovery actions, and auditable revenue outcomes.

The MVP is built for the Razorpay AI Buildathon’s **AI Revenue Recovery** track. It uses synthetic data and Razorpay Test Mode only.

## Actors

- **Merchant:** The SaaS business whose renewal revenue is at risk.
- **Customer:** The payer whose renewal attempt failed.
- **Recovery operator:** The human who reviews explanations, escalations, and outcomes.
- **Payment provider:** Razorpay Test Mode or the deterministic simulator.
- **Diagnosis model:** The AI component that recommends, but never authorizes, an intervention.
- **Policy engine:** The deterministic authority that permits or rejects recovery actions.

## Glossary

### Recovery Case

The aggregate for one failed renewal. It owns the immutable renewal context, provider events, diagnosis, policy decisions, recovery actions, outcome, and audit timeline.

### Revenue at Risk

The original amount of an unresolved failed renewal. It is not a prediction and is not counted after the case reaches a terminal outcome.

### Payment Attempt

A provider-observed attempt to collect the renewal amount. An arbitrary card payment is not assumed to be automatically retryable.

### Diagnosis

Structured AI output containing the likely failure category, confidence, cited evidence, recommended action, and human-readable explanation. A Diagnosis is advisory.

### Policy Decision

The deterministic authorization or rejection of a recommended Recovery Action. Policy is the sole authority for initiating provider side effects.

### Recovery Action

One bounded intervention associated with a Recovery Case. The MVP supports an eligible authorized recurring-payment retry, fallback payment-link creation, stop, and escalation.

### Retry

One provider-supported attempt to collect the unchanged renewal through an existing authorized recurring mandate. It does not mean recharging an arbitrary card payment.

### Fallback Payment Link

An expiring provider link that lets the Customer actively complete the unchanged renewal after an unsuccessful or ineligible Retry.

### Recovered Revenue

A successful payment correlated to the original Recovery Case after an approved Recovery Action. Unrelated or pre-existing payments do not count.

### Escalation

A terminal handoff to the Recovery operator because automation is uncertain, unsafe, unsupported, or exhausted.

### Exhausted

A terminal outcome reached when the permitted Retry and Fallback Payment Link do not recover the renewal.

### Audit Event

An append-only record of an input, recommendation, decision, attempted side effect, provider result, manual action, or outcome.

### Evaluation Run

A reproducible execution of the recovery workflow across a seeded synthetic batch with known expected safe actions and outcomes.

## Core invariants

1. The Diagnosis model never receives payment credentials and never executes a Recovery Action.
2. Deterministic policy authorizes every provider side effect.
3. A Recovery Case receives at most one Retry and one Fallback Payment Link.
4. Recovery Actions cannot change the original customer, subscription, amount, or currency.
5. Provider events and Recovery Actions are idempotent.
6. A successful or otherwise terminal case cannot produce later Recovery Actions.
7. Uncertain, malformed, unsupported, or inconsistent inputs fail safe to Escalation.
8. Recovered Revenue is counted only through explicit correlation and is reconcilable to individual cases.
9. Every recommendation, decision, action, and outcome is auditable.

## MVP boundary

Included: failed SaaS renewals, AI diagnosis, deterministic policy, one eligible Retry, one Fallback Payment Link, escalation, simulator, Razorpay Test Mode adapter, 50+ case evaluation, metrics, and merchant dashboard.

Excluded: real money, arbitrary card retries, checkout abandonment, invoices, fraud, refunds, production messaging, multi-tenancy, and agentic-commerce protocols.
