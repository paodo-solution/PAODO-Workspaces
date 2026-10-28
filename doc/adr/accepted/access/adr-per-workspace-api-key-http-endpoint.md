# ADR — Per-workspace API key & HTTP agent endpoint

Status: Accepted

## Context

External tools (scripts, bots, other systems) need to send work to a workspace agent over HTTP. These endpoints are reachable from the internet, so a leaked key must expose only one workspace and be easy to revoke.

## Decision

Each workspace has its own API key, sent as a Bearer token. The key is shown once at generation, stored only as a hash, and can be revoked, rotated, or disabled; the unified credential store manages it.

The key unlocks two endpoints:

- `POST /api/workspaces/<id>/agent` sends a message and streams the agent's reply as Server-Sent Events. Each call starts a new conversation unless it passes a `conversationId` to continue one. It returns `409` if a run is already in progress there.
- `POST /api/workspaces/<id>/agent/stop` stops a run by `conversationId`.

API runs go through the same run broker as the chat UI, so each one is a normal persisted conversation that the owner can open, follow live, or stop from the UI.

Calls are rate-limited per client IP and per workspace.

## Consequences

- A leaked key exposes one workspace and is revoked without touching any other.
- API activity is as visible and reviewable as chat activity.
- Callers can hold a multi-turn conversation by reusing its `conversationId`, or get a fresh context by omitting it.
- Requires key management in the UI (generate, revoke, enable/disable).

## Alternatives considered

- **Platform-wide API key**: too coarse; one leak would expose every workspace.
- **OAuth/JWT-based integration**: more complexity than needed for self-hosted use.
- **Stateless calls with no stored conversation**: API runs would be invisible in the UI and could not continue a conversation.

## Notes

- Related ADRs: [adr-unified-credential-store.md](adr-unified-credential-store.md) (how keys are stored), [adr-workspace-mcp-skill-gateway.md](adr-workspace-mcp-skill-gateway.md) (MCP access, with its own separate key).
