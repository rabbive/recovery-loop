# ADR-0001: AI recommends; deterministic policy authorizes

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Recovery Loop uses AI to interpret heterogeneous payment-failure evidence and recommend a next-best intervention. Those recommendations can affect money movement and customer contact. Model output is probabilistic, can be malformed or unavailable, and must not be treated as authorization.

The buildathon also requires every money action to be explainable, bounded, gated, and auditable.

## Decision

The Diagnosis model is advisory. It returns a structured failure category, confidence, evidence references, recommended action, and explanation. It receives no provider credentials and cannot invoke provider operations.

A deterministic policy engine is the sole authority that permits a Recovery Action. It evaluates immutable payment context, case state, confidence, retry eligibility, action limits, expiry, and stop conditions. Rejected recommendations and their reasons are written to the audit timeline without producing a side effect.

A model timeout, malformed output, unsupported recommendation, low confidence, or inconsistent case fails safe to Escalation.

The MVP permits at most one provider-supported recurring Retry and one expiring Fallback Payment Link per Recovery Case. Success or any other terminal outcome blocks later actions.

## Consequences

### Positive

- Model behavior cannot bypass money-movement safeguards.
- Safety rules are deterministic and directly testable.
- Operators can distinguish AI reasoning from policy authorization.
- The system can change models without changing financial controls.
- Failure of the model degrades to human review rather than unsafe execution.

### Negative

- Some useful AI recommendations will be blocked by conservative policy.
- Diagnosis and policy require separate schemas, versions, and audit records.
- Recovery capability is limited to actions explicitly represented in policy.

## Alternatives considered

### Let the model invoke payment tools directly

Rejected because prompt-level restrictions are not a reliable authorization boundary and would violate the project’s bounded-action requirement.

### Use deterministic rules for diagnosis and authorization

Rejected as the complete product because heterogeneous failure evidence is where AI can add useful interpretation. Deterministic mappings remain valid fallbacks and evaluation baselines, but do not replace the advisory Diagnosis model.

### Require a human to approve every action

Rejected for the MVP because it would demonstrate decision support rather than a bounded recovery loop. Human review remains mandatory for uncertain, unsafe, or exhausted cases.
