# ADR — Single-instance, in-process coordination state

Status: Accepted

## Context

PAODO runs as one Node.js process on one VPS. Durable data is on disk (JSON files and the SQLite database), but the live coordination state is held in that process's memory, shared across bundles through `global` (see [adr-global-object-hot-reload-survival.md](adr-global-object-hot-reload-survival.md)):

- **Workspaces**: the registry and the agent graph.
- **Runs**: in-flight runs with their event buffers and subscribers (run broker), the conversation cache, and execution-capacity and provider concurrency limits.
- **Real-time**: WebSocket connections and file watchers.
- **Containers**: idle timers, start/stop locks, network cleanup and credential-proxy attachment.
- **Scheduling**: the tick timer and the set of in-flight scheduled runs.
- **Security**: the credential cache, the internet-access policy, and rate-limit and auth-failure counters.

This ADR records that relying on one process is intentional, not an oversight.

## Decision

PAODO is single-instance by design and scales vertically only. It does not run multiple replicas behind a load balancer. Docker is host-local, so the one process on a host owns every workspace container on it.

## Consequences

- Simple, low-latency, easy to self-host: no Redis or external database for live state.
- Container locks and timers, run tracking, and limits are correct because one process sees everything.
- The only way to add capacity is a bigger VPS.
- Running two replicas would appear to work in a smoke test, then fail under load:
  - two processes race to create and stop the same container;
  - a request routed to the other replica cannot see or stop a running run;
  - live output is lost when the run and the browser's WebSocket are in different processes;
  - every schedule fires twice;
  - rate limits and execution caps become N times the configured value, and a revoked key keeps working until each replica reloads.
- Going multi-instance would first require moving live state to a shared store (Redis or Postgres), WebSocket fan-out through pub/sub, and a single owner per container.

## Alternatives considered

- **Externalize state up front (Redis/Postgres + pub/sub)**: enables horizontal scaling, but adds infrastructure and operational work a single-VPS product does not need. Deferred until a real multi-instance requirement exists.
- **Leave the assumption implicit**: rejected, because the dependency is spread across dozens of modules and only visible by tracing `global` usage, which makes it an easy trap for a future "just add replicas" change.

## Notes

- Related ADRs: [adr-global-object-hot-reload-survival.md](adr-global-object-hot-reload-survival.md), [adr-in-process-cron-scheduler.md](adr-in-process-cron-scheduler.md), [adr-container-per-workspace-sandbox.md](../sandbox/adr-container-per-workspace-sandbox.md).
