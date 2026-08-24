# ADR-0002: Provider contract with simulator-first evaluation

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

The hackathon requires measured recovery across a batch, but Razorpay Test Mode is an integration environment rather than a controllable source of every failure, delay, duplicate, and recovery outcome needed for a reproducible evaluation. Public APIs also do not imply that arbitrary failed card payments can be retried automatically.

Depending entirely on external Test Mode behavior would make the demo fragile and could encourage technically inaccurate claims. Depending only on mocks would fail to prove that the product integrates with Razorpay.

## Decision

Recovery orchestration depends on a narrow payment-provider contract covering:

- verification and normalization of provider events;
- determining whether an authorized recurring Retry is supported;
- submitting an idempotent Retry;
- creating an expiring Fallback Payment Link; and
- looking up or ingesting outcomes.

Two adapters implement the contract:

1. A deterministic simulator drives the seeded 50+ case evaluation and all adverse event sequences.
2. A Razorpay Test Mode adapter demonstrates supported real integration operations without moving money.

The simulator is not represented as Razorpay behavior or production performance. Batch recovery metrics are explicitly labeled synthetic. Live integration claims are limited to operations actually exercised against Test Mode.

Shared contract tests keep both adapters aligned at the application boundary. The same Recovery Case workflow, policy, audit, and metrics code is used with either adapter.

## Consequences

### Positive

- Evaluation is deterministic, reproducible, and rich in edge cases.
- The complete demo works without credentials or external availability.
- Razorpay integration remains visible and replaceable without contaminating domain policy.
- Unsupported automatic retry semantics are not hidden behind a mock.
- Duplicate, delayed, and contradictory event handling can be proved reliably.

### Negative

- Two adapters must be implemented and kept behaviorally aligned.
- Synthetic recovery rates cannot be presented as expected production results.
- Some Test Mode operations may remain shallower than the simulator scenarios.

## Alternatives considered

### Use Razorpay Test Mode for the entire evaluation

Rejected because external Test Mode cannot reliably produce every controlled failure and timing sequence needed for batch assertions.

### Use only a mocked provider

Rejected because the buildathon specifically calls for Razorpay Test Mode APIs and an integration proof materially strengthens the submission.

### Embed Razorpay calls throughout the workflow

Rejected because provider behavior would leak into domain policy, tests would become fragile, and the simulator could not exercise the same end-to-end seam.
