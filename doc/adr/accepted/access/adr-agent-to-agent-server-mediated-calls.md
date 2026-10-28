# ADR — Agent-to-agent calls via server-mediated skill contracts (acyclic graph)

Status: Accepted

## Context

Complex services benefit from specialized agents that delegate work to other workspace agents. Direct container-to-container networking is undesired for security and isolation reasons.

## Decision

Implement a directed, acyclic agent network where calls are routed through the platform server (`call_agent` tool). Each call invokes the callee with a fresh conversation context. Acyclicity is enforced both client-side (UI rejects the connection on draw) and server-side (`saveGraph` throws on cycle detection). A graph editor lets users define allowed connections.

Calls are typed skill invocations, not free-form messages. A workspace declares skills in `.skills/*.json`, each with JSON Schema input and output; one without skills is not callable. Callers discover them with `list_agents`. `executeSkill` enforces the contract:

1. Authorize: the graph edge is the only caller identity.
2. Validate input before the callee runs; a rejected call creates no conversation.
3. Run the callee in a new conversation persisted in its own workspace, deep-linked from the caller.
4. Validate output: a single JSON object matching the output schema. Invalid output gets bounded correction retries (`skillOutputMaxRetries`) in the same conversation.
5. A callee that cannot proceed replies `{"_needs_input": "<question>"}`, returned as `NEEDS_INPUT` without consuming retries.

Failures return typed codes so the caller knows whether to fix args, retry, or stop. The caller side caps repeated invalid calls (`skillInputMaxRetries`) and needs-input rounds (`skillNeedsInputMaxRounds`). Timeouts and cancellation cascade down the call chain. MCP clients use the same path.

## Consequences

- The caller only ever sees validated output; agent-to-agent calls behave like an API contract.
- Controlled and auditable cross-workspace interactions; every callee run is a reviewable conversation.
- Callee runs are stateless by design; callers must manage state if they need it.
- Skill authors must write JSON Schema contracts; changing one breaks callers they cannot see.
- Requires server routing logic and UI for graph management.
- Does NOT stop: a corrupted callee rewriting its own skills to lure callers into sending it their data.

## Alternatives considered

- **Direct container networking**: risk of lateral movement and weaker access control.
- **Shared persistent state for hand-offs**: breaks isolation guarantees.
- **Free-form messages between agents**: the caller must interpret prose; nothing is validated.
- **Failing on the first invalid output**: models often fix their output when given the exact error.

## Notes

- Related ADR: [Workspace MCP gateway over declared skills](adr-workspace-mcp-skill-gateway.md) — exposes the same skills and `executeSkill` path to external MCP clients.
