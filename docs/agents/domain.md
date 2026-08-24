# Domain docs

This is a single-context repository.

## Before exploring

- Read `CONTEXT.md` at the repository root when it exists.
- Read relevant ADRs under `docs/adr/` when they exist.

If these files do not exist, proceed without flagging their absence. Create domain documentation lazily when the domain model or an architectural decision is settled.

## Layout

```text
/
├── CONTEXT.md
└── docs/adr/
```

Use terminology from `CONTEXT.md` when it exists. Surface conflicts with existing ADRs instead of silently overriding them.
