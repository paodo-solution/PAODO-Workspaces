# ADR — Global object for shared in-process state

Status: Accepted

## Context

The app runs as one Node.js process, but its code is loaded more than once: the custom server (`server.ts`) and the Next.js-bundled API routes each get their own copy of every module, and dev mode re-evaluates modules on every hot reload. A module-level `Map` or singleton would therefore exist in several copies — a workspace created through an API route would be invisible to the WebSocket handler — and would be wiped on each reload in development.

## Decision

Shared in-process state lives on the Node.js `global` object, which every module copy sees and hot reloads do not reset. Most modules use `globalSingleton(key, init)` (`lib/infra/globalSingleton.ts`), which creates the value once and returns the same instance everywhere. Others, such as `wsHub.ts`, `registry.ts` and `runBroker.ts`, store their state directly under a prefixed `global` key.

## Consequences

- The server and the API routes share one workspace registry, one set of WebSocket connections, and one copy of every other piece of shared state.
- Live connections and in-memory state survive dev-mode reloads.
- Keys must be unique across the codebase; a collision silently shares state between unrelated modules.
- The state exists only in this one process, which ties the app to a single instance (see [adr-single-instance-in-process-state.md](adr-single-instance-in-process-state.md)).

## Alternatives considered

- **Module-level singletons**: simple, but duplicated across the server and route bundles and reset on every hot reload.
- **External process (Redis, SQLite) for live state**: durable but heavy for a self-hosted single-process app.
