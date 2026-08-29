# Release hardening implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the verified correctness and release blockers from the current Recovery Loop HEAD before committing and deploying the buildathon candidate.

**Architecture:** Keep the existing single-process TypeScript application and its provider boundary. Make registration decisions inside the same per-case transaction as the write, return an explicit expiry transition result, and make the Razorpay retry identity live on a fresh action-keyed order and charge. Preserve the simulator-first evaluation and the disabled recurring flag until a real mandate proof exists.

**Tech Stack:** TypeScript 5.7, Node.js 22, Vitest, PostgreSQL 16/`pg`, Heroku.

**Spec:** `docs/superpowers/specs/2026-08-28-hackathon-readiness-design.md` and `docs/specs/recovery-loop-mvp.md`.

## Global Constraints

- Diagnosis remains advisory; deterministic policy remains the only action authorizer.
- Every Recovery Case permits at most one retry and one fallback link.
- No retry may alter the registered customer, subscription, order, amount, or currency.
- Provider operations carry the Recovery Action idempotency identity and remain safe after a process crash.
- Canonical webhook ingress never accepts renewal context from the webhook body.
- `RAZORPAY_RECURRING_RETRY_ENABLED` stays false until `tests/razorpay-recurring-proof.test.ts` passes with a real Test Mode mandate.
- Do not print or commit credentials. Keep `.env` ignored and unchanged.
- Use a failing regression test before each production-code change, then run the focused suite and the full suite.
- Preserve the public simulator, isolated replay lab, seeded evaluation, and durable PostgreSQL behavior.

### Task 1: Atomic registration, webhook identity, and expiry results

**Files:**

- Modify: `src/recovery.ts`, `src/http.ts`, `src/webhook.ts`, `src/expiry.ts`
- Modify: `tests/http.test.ts`, `tests/orchestration.test.ts`, `tests/expiry.test.ts`

**Interfaces:**

- Add `RecoveryCaseConflictError` for a registration whose immutable context differs from the stored case.
- Make `RecoveryWorkflow.openCase(id, context)` read the locked transaction before saving: equal context returns the existing case; different context throws `RecoveryCaseConflictError`.
- Add `ExpiryResult = { recoveryCase: RecoveryCase; expired: boolean }` and `RecoveryWorkflow.expireLapsedFallbackLinkWithOutcome(caseId)`; retain `expireLapsedFallbackLink(caseId): Promise<RecoveryCase>` as a compatibility wrapper.
- Make `ExpirySweeper` report only `ExpiryResult.expired === true`.

- [ ] **Step 1: Add failing regression tests.** Cover concurrent conflicting `openCase` calls, HTTP `201/200/409` registration semantics, a signed payment-link webhook whose only `caseId` is in `payment_link.entity.notes`, and a sweep where the case is already exhausted when the lock is acquired.

- [ ] **Step 2: Run the focused tests and confirm each regression fails for the expected reason.**

  ```bash
  npm test -- tests/http.test.ts tests/orchestration.test.ts tests/expiry.test.ts
  ```

- [ ] **Step 3: Implement the smallest transaction-aware fixes.** Remove the unlocked registration preflight from `src/http.ts`; map `RecoveryCaseConflictError` to `409`. Add `paymentLinkNotes.caseId` to webhook case resolution. Implement the explicit expiry outcome inside the existing case lock so a concurrent terminal case cannot be reported as newly expired.

- [ ] **Step 4: Run the focused tests, then typecheck.**

  ```bash
  npm test -- tests/http.test.ts tests/orchestration.test.ts tests/expiry.test.ts
  npm run typecheck
  ```

- [ ] **Step 5: Commit the task.**

  ```bash
  git add src/recovery.ts src/http.ts src/webhook.ts src/expiry.ts tests/http.test.ts tests/orchestration.test.ts tests/expiry.test.ts
  git commit -m "fix: make registration and expiry atomic"
  ```

### Task 2: Idempotent, identity-checked Razorpay retries

**Files:**

- Modify: `src/provider.ts`, `tests/razorpay-adapter.test.ts`, `tests/razorpay-integration.test.ts`
- Modify: `README.md`, `docs/research/razorpay-test-mode-mandate-setup.md` only where the current retry behavior is described

**Interfaces:**

- Keep `PaymentProvider.submitRetry(recoveryCase, action): Promise<ProviderResult>` unchanged.
- Add private adapter helpers for action-keyed order lookup/creation and for validating provider payment identity against the registered case.

- [ ] **Step 1: Add failing adapter tests.** Assert that one action creates one fresh order keyed by its receipt/action identity, includes `caseId`, `subscriptionId`, and `recoveryActionKey` notes, carries the action identity into the recurring charge, replays a `created` payment without a second charge, and refuses before any POST when provider customer/order/subscription identity disagrees with the case.

- [ ] **Step 2: Run the focused adapter tests and confirm the new tests fail.**

  ```bash
  npm test -- tests/razorpay-adapter.test.ts
  ```

- [ ] **Step 3: Implement the retry flow.** Read the original payment and require a complete mandate. Require provider customer and original order to match the registered context, and require a matching subscription identity from the provider payment/order notes before charging. Look up an existing action-keyed order by receipt before creating it; on an existing order, treat any payment state on that order as the same action and return its payment reference. Create the new order with the action receipt and notes, then call `/v1/payments/create/recurring` with boolean `recurring: true`, the original amount/currency, the mandate identity, and the action identity in notes. Resolve duplicate-order responses through the same lookup path.

- [ ] **Step 4: Update the README and sourced research to describe the implemented order and idempotency semantics.** Do not claim recurring proof exists; keep the disabled flag and account blocker explicit.

- [ ] **Step 5: Run adapter, contract, workflow, and typecheck suites.**

  ```bash
  npm test -- tests/razorpay-adapter.test.ts tests/razorpay-integration.test.ts tests/provider-contract.test.ts tests/workflow.test.ts
  npm run typecheck
  ```

- [ ] **Step 6: Commit the task.**

  ```bash
  git add src/provider.ts tests/razorpay-adapter.test.ts tests/razorpay-integration.test.ts tests/provider-contract.test.ts tests/workflow.test.ts README.md docs/research/razorpay-test-mode-mandate-setup.md
  git commit -m "fix: make Razorpay retries idempotent"
  ```

### Task 3: PostgreSQL URL portability and dependency hygiene

**Files:**

- Modify: `src/persistence.ts`, `tests/persistence.test.ts`
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Add a failing connection test for socket-style URLs.** Assert that `postgresql:///recovery_loop_test` selects `ssl: false`, alongside the existing loopback and managed-host assertions.

- [ ] **Step 2: Run the focused test and confirm it fails.**

  ```bash
  npm test -- tests/persistence.test.ts -t "connection encryption"
  ```

- [ ] **Step 3: Fix `sslFor` to recognize socket-style local URLs without weakening TLS for managed hosts.** Keep explicit `config.ssl` overrides working.

- [ ] **Step 4: Upgrade the direct Vitest development dependency to the current Node-22-compatible release using an isolated npm cache, regenerate the lockfile, and run the full audit.**

  ```bash
  npm_config_cache=/tmp/recovery-loop-npm-cache npm install --save-dev vitest@4.1.11
  npm audit
  npm audit --omit=dev
  ```

- [ ] **Step 5: Run the complete verification suite.**

  ```bash
  npm ci
  TEST_DATABASE_URL=postgres://$(id -un)@127.0.0.1:5432/recovery_loop_test npm test
  npm run lint
  npm run build
  gitleaks git --no-banner --redact .
  ```

- [ ] **Step 6: Commit the task.**

  ```bash
  git add src/persistence.ts tests/persistence.test.ts package.json package-lock.json
  git commit -m "chore: harden release dependencies"
  ```

## Release verification after all tasks

- Verify the final branch is clean and the pushed SHA matches the audited SHA.
- Run the full local PostgreSQL suite, live Test Mode fallback suite, browser smoke flow, and gitleaks scan.
- Push the corrected branch, deploy that exact SHA to Heroku, verify `/healthz`, `/api/runtime`, `/api/metrics`, and `/api/evaluation`.
- Restart the dyno, then verify the same evaluation seed, case count, and published run survive.
- Update issue #24 with the new evidence. Keep issue #22 open until Razorpay enables recurring mandates. Close issue #1 only if its full acceptance criteria are now represented by the deployed candidate.
