# ADR — Triggers are adapters over shared operations

Status: Accepted

## Context

The same action can be started from the UI, the CLI, the HTTP API, MCP, a schedule or another agent. If each entry point holds its own rules, behavior drifts depending on who called.

## Decision

Split every entry point into a **trigger** and an **operation**.

```text
UI · CLI · HTTP API · MCP · Schedules · Agent graph      (triggers)
                         │
                         ▼
                  lib/operations/                         (operations)
                         │
                         ▼
          stores · run broker · containers · files
```

- **A trigger is an adapter.** It authenticates the caller, translates the input, calls one operation and formats the result. It holds no business rules.
- **An operation owns the rules.** It knows nothing about HTTP or any transport. It throws coded errors, and each trigger maps them to its own format.
- **The UI and CLI share the same routes.** There is no `/api/cli/...` tree, and a route is open to the CLI only if it is explicitly allowed. Only the agent endpoint, MCP and the settings token route stay separate, because their transport or caller differs.
- **Mutations return receipts.** A receipt lists the fields applied and their canonical values, using the public field names. It is not a resource snapshot, and it never carries a read-once secret.

## Consequences

- Every caller gets the same behavior, and a fix applies everywhere.
- A new trigger is a thin adapter, and a new capability is written once.
- Nothing enforces the boundary yet; only review keeps rules out of triggers.

## Alternatives considered

- **Rules in each route or handler**: rules drift between triggers, and fixes must be repeated.
- **A separate API for the CLI**: duplicates routes and lets the CLI diverge from the UI.

## Notes

- CLI allowlist: [Platform CLI access policy](adr-platform-cli-access-policy.md)
