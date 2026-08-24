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

Runtime configuration is documented in `.env.example`. Keep credentials outside the repository.

## Architecture

- `src/domain.ts`: Recovery Case types, lifecycle, immutable renewal context, and audit helpers.
- `src/recovery.ts`: application workflow seam, diagnosis, deterministic policy, store, and idempotent action execution.
- `src/provider.ts`: provider contract, deterministic simulator, and Razorpay Test Mode adapter seam.
- `src/evaluation.ts`: seeded 50+ case evaluation and reconciliation metrics.
- `src/server.ts`: single-process HTTP API and dashboard.
- `src/persistence.sql`: PostgreSQL persistence foundation for productionizing the in-memory store.

The workflow accepts its clock, diagnosis engine, policy, store, and provider as dependencies. Tests exercise behavior at that seam rather than private implementation details.

## Synthetic evaluation

```bash
node --input-type=module -e "import('./dist/src/evaluation.js').then(({runEvaluation}) => console.log(runEvaluation()))"
```

Synthetic results must not be presented as expected production performance. Razorpay credentials are optional and only used for a separately configured Test Mode integration.

## Documentation

- [MVP specification](docs/specs/recovery-loop-mvp.md)
- [Domain context](CONTEXT.md)
- [ADR-0001: AI recommends; deterministic policy authorizes](docs/adr/0001-ai-recommends-policy-authorizes.md)
- [ADR-0002: Provider contract with simulator-first evaluation](docs/adr/0002-provider-contract-and-simulator-first.md)
