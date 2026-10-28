# ADR — Agent run loop and run broker

Status: Accepted

## Context

A workspace run can last many minutes (long tool calls, nested `call_agent` runs) and is started from five places: the chat UI, the HTTP API, MCP, the scheduler and another agent. A run must not depend on the HTTP request that started it: a closed tab, a dropped proxy connection or an API client that only wants a receipt must not kill it. It must still be watchable live, stoppable, bounded in time and cost, and leave a conversation history that is always valid to resume.

## Decision

Split a run into two layers: a **run loop** that knows nothing about transport, and a **run broker** that owns the run's lifetime and fans its events out.

**Run loop** — `runAgent` in `lib/agent/runner.ts`, an async generator of `AgentEvent`s.

- **ReAct loop**: stream a model turn (`modelTurn.ts`, through the model gateway), dispatch its tool calls in parallel (`toolDispatch.ts`), repeat until a turn has no tool calls. `maxIterations` ends with `limit_reached`, then a final answer synthesized without tools.
- **Atomic history commit**: the assistant turn and all its `ToolMessage`s are pushed in one synchronous block, after every tool has settled. An abort can only land at a `yield`, so history holds a whole tool turn or none of it.
- **One event contract** for every consumer: `token`, `reasoning`, `tool_start`/`tool_link`/`tool_result`, `paced`, `turn_usage`, `limit_reached`, `error` (with a stable `AgentErrorCode`), and always a final `done`.
- **Fail before spending**: an unusable model selection is rejected before the container is warmed or a provider is called. Provider throws are classified into a coded `error`, never a raw string.
- **Side effects at fixed points**: a versioning baseline commit before the first turn and a result commit in `finally` on every exit path. Signal tools (compact, restore…) run their handlers after the commit, through `buildTools.signalHandlers`, so a new one never touches the loop.

**Run broker** — `lib/agent/runBroker.ts`, an in-process `Map` on `global` keyed by `(workspaceId, conversationId)`.

- **Detached**: `startRun` launches the loop without awaiting it and returns at once. Only `stop()`, the workspace timeout or the run's own end finishes it.
- **One run per conversation**: a second start returns `alreadyRunning` (HTTP 409).
- **Buffer and fan-out**: every event is buffered and sent to all subscribers. `subscribe` returns the replay and registers the callback in one synchronous step, so a late viewer replays and then follows live without a gap. A finished run lingers 30 s for viewers that reconnect at the end.
- **Terminal events are owned by the broker**: on timeout or Stop, it drops the provider's abort error and publishes one stable `TIMEOUT` or `CANCELLED` error, then `done`. A throw before the loop, or a loop that ends without `done`, is turned into an error event, so no consumer is left with an open, silent stream.
- **Guards**: a process-wide execution capacity (`MAX_CONCURRENT_AGENT_RUNS`, default 10) refuses a run before it starts, and a per-workspace wall-clock timer (`maxRunMinutes`) is combined with the Stop signal into one `AbortSignal`.
- **Lifecycle bookkeeping** in one place: the usage session (origin, terminal status, per-turn usage), `noteRunStart`/`noteRunEnd` so the idle reaper never stops a container mid-run, and `conversations.persist` once at run end.
- **External runs**: `startExternalRun` registers a run whose events come from elsewhere. `executeSkill` (used by `call_agent` and MCP) drives the callee itself to validate its output, but publishes through the broker so the callee's own tab can watch and stop it.

**Entry points** go through `startWorkspaceRun` (`lib/operations/agent/run.ts`), which resolves or creates the conversation, rebuilds the system prompt and calls `startRun`. Each transport is then only a subscriber:

| Trigger              | Origin      | Consumes events through                                  |
| -------------------- | ----------- | -------------------------------------------------------- |
| Chat UI              | `chat`      | `chat/route.ts`: raw events as SSE; empty message = attach |
| HTTP API             | `api`       | `workspaceRunStream.ts`: public SSE projection + `response` |
| Scheduler            | `scheduled` | a subscriber recording the outcome on the schedule       |
| `call_agent`, MCP    | `agent`, `mcp` | `executeSkill` via `startExternalRun`                  |

SSE responses send a keepalive frame every 15 s so proxies do not drop a stream during a silent tool call. Closing a stream only unsubscribes.

## Consequences

- A run survives tab closes, reloads and dropped connections, and any viewer can re-attach and replay it.
- Every trigger gets the same capacity limit, timeout, Stop, usage record, container keep-warm and persistence, without reimplementing them.
- History is always resumable after an abort, a timeout or a failure.
- A new transport is a new subscriber; a new tool or signal tool does not change the loop.
- Runs live in one Node process: a restart loses in-flight runs and their buffers (history persisted at the previous run end survives). This ties the broker to single-instance deployment.
- History is saved only at run end, so a crash mid-run loses that run's turns.
- The event buffer grows with the run and is held in memory until eviction.
- The scheduler keeps its own per-workspace in-flight guard, since each fire uses a new conversation.

## Alternatives considered

- **Run tied to the HTTP request**: simplest, but a closed tab or proxy timeout kills the run and leaves half-written history.
- **External job queue (Redis, BullMQ)**: survives restarts and scales out, but adds infrastructure the single-box deployment does not need.
- **Persisting every event**: replay after a restart, at the cost of a write per token; the persisted history already covers reload.
- **Polling instead of SSE**: no fan-out to build, but laggy token streaming and more load.
- **A separate loop per trigger**: duplicates the guards and the event semantics, which then drift.

## Notes

- Related: [adr-single-instance-in-process-state.md](../platform/adr-single-instance-in-process-state.md), [adr-global-object-hot-reload-survival.md](../platform/adr-global-object-hot-reload-survival.md), [adr-agent-to-agent-server-mediated-calls.md](../access/adr-agent-to-agent-server-mediated-calls.md), [adr-system-prompt-rebuilt-per-request.md](adr-system-prompt-rebuilt-per-request.md), [adr-conversation-and-execution-data-sqlite.md](adr-conversation-and-execution-data-sqlite.md), [adr-model-gateway-provider-layer.md](adr-model-gateway-provider-layer.md), [adr-trigger-adapters-shared-operations.md](../access/adr-trigger-adapters-shared-operations.md).
