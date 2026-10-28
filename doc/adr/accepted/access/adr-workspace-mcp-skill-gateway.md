# ADR — Workspace MCP gateway over declared skills

Status: Accepted

## Context

External AI clients need a standard way to discover and call a workspace's capabilities without access to the PAODO UI, the workspace's files, or the agent network. The intended caller is a client the owner has deliberately given a key to, typically another of their own agents, not an anonymous one.

## Decision

Each workspace can expose an MCP endpoint, `POST /api/workspaces/<id>/mcp`, over stateless Streamable HTTP.

- **Authentication**: a dedicated per-workspace MCP key, separate from the HTTP API key, managed by the unified credential store (generate, rotate, revoke, enable/disable).
- **Tools**: every skill the workspace declares in `.skills/`, read live on each request. Input and output schemas must be JSON objects. There is no per-skill publication: an enabled endpoint plus a valid key authorizes every skill, just as a graph edge authorizes a whole workspace for agent-to-agent calls.
- **Execution**: tool calls go through `executeSkill`, with the same validation, correction retries and conversation as agent-to-agent calls; the MCP key replaces the graph-edge check.
- **Stateless**: each request gets a fresh MCP server and one buffered JSON response; `GET` and `DELETE` return `405`.
- **Limits**: rate-limited per client IP and per workspace.

## Consequences

- MCP and agent-to-agent calls share one skill contract and execution path; no skill is exposed to one and not the other.
- The tool list is whatever the workspace agent has written to `.skills/`: a new skill is callable immediately, a deleted one disappears.
- Exposure is therefore agent-controlled. A prompt injection reaching the agent can add a skill, but a caller still needs the key, and a skill grants no capability the agent does not already have. The key and the on/off switch are stored outside the workspace, so the agent cannot change them. The same agent-written contract is read by agent-network callers (see the "Does NOT stop" entry in [adr-agent-to-agent-server-mediated-calls.md](adr-agent-to-agent-server-mediated-calls.md)).
- Being stateless, the endpoint cannot notify clients that the tool list changed. A client using a cached list gets an "Unknown tool" error naming the available tools, or an input validation error if a schema changed, so integrations should re-read the list.
- Each tool call creates a reviewable conversation in the workspace.

## Alternatives considered

- **Per-skill publication chosen by the owner**: approves a skill's name while the agent can still change what it does, and a skill deleted and recreated under the same name regains exposure. It adds a store, an API and a UI without limiting what a caller can reach.
- **Owner approval of the exposed set, re-approved on change**: unnecessary for a trusted-client audience; worth revisiting if MCP access is ever given to someone the owner does not control.
- **A `visibility` field in each skill file**: `.skills/` is agent-writable, so it cannot hold a decision the agent is not allowed to make.
- **Reusing the HTTP API key**: MCP access must be revocable on its own.
- **Stateful MCP sessions with SSE**: current tools only need request/response.
- **A separate MCP execution engine**: validation and runtime behavior would drift from agent-to-agent calls.

## Notes

- Related: [adr-agent-to-agent-server-mediated-calls.md](adr-agent-to-agent-server-mediated-calls.md), [adr-unified-credential-store.md](adr-unified-credential-store.md), [prd-workspace-mcp.md](../../../prd/accepted/prd-workspace-mcp.md).
