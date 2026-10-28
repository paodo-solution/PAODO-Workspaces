# ADR — Agent-driven context compaction and prefix prompt caching

Status: Accepted

## Context

Long runs grow the conversation every turn, and bulky re-derivable tool output (file reads, searches, command logs) dominates that growth. Each turn resends the whole history, so cost compounds and the model's context window eventually runs out. Any trimming must keep history valid for every provider: no `tool_call` without its `tool_result`. Providers also discount a repeated request prefix, but each exposes caching differently, and a rewritten history loses that discount.

## Decision

**Compaction is a signal tool the agent calls**, not a size-triggered process.

- `compact_context` (`lib/agent/tools/compactContext.ts`) takes a `level` and a required `next_step`, and only returns an ack. The system prompt tells the agent when to use each level.
- The runner applies it through `buildTools.signalHandlers`, after the turn's atomic commit (`applyCompaction` in `lib/agent/compact.ts`). Only whole turns are kept or wiped, so no tool call is orphaned.
- The live messages array is rewritten in place with `splice`, and `messages[0]` (the system prompt) is always kept. The broker persists that array at run end, so the stored replay is the compacted history.

| Level    | Effect                                                                                          | LLM call |
| -------- | ----------------------------------------------------------------------------------------------- | -------- |
| `light`  | Results of `STRIPPABLE_TOOLS` (`file_read`, `glob`, `list_directory`, `http_get`, `execute_command`) replaced by a placeholder | No       |
| `medium` | Head summarized into one message, last ~6 messages kept verbatim from an `AIMessage` boundary, then `light` | Yes      |
| `hard`   | `[system, summary + next step]`; also the fallback when `medium` finds no boundary              | Yes      |

- The summary is one tool-less call to the workspace's own model through the `ModelGateway`, tagged `stage: "compaction"`, so it is paced and retried like any turn. Its usage is parked during the handler and emitted as separate `turn_usage` rows.
- A failed compaction is logged and leaves history untouched.

**Prompt caching relies on a stable prefix**, configured per provider in the `PROVIDERS` registry (`lib/agent/buildModel.ts`):

- The system message is two blocks: static instructions, then workspace context (network, drives, secrets, background tasks, `AGENTS.md`, date) (`lib/agent/systemPrompt.ts`).
- **Anthropic** (`supportsPromptCaching: true`): `cache_control: ephemeral` on the last system block, since the static block alone is under the 1024-token minimum. `ANTHROPIC_CACHE_TTL_1H=true` adds `ttl: "1h"` and the `prompt-caching-scope-2026-01-05` beta header.
- **Mistral**: `promptCacheKey` set to the conversation id (`cacheScopeId`). The broker sets the scope itself, so it always follows the persisted history.
- **Other providers**: no marker; they rely on the provider's automatic prefix caching where it exists.
- `usageTokens` (`lib/agent/modelGateway.ts`) normalizes cache reads (`cache_read`, `prompt_cache_hit_tokens`, `cached_tokens`) and writes (`cache_creation`), shown in the chat token line and the dashboard.

## Consequences

- Long jobs keep running without context errors, and history stays resumable on any provider.
- `light` is lossless for reasoning and free; `medium`/`hard` lose detail and cost one request the size of the whole history, usually the largest of the run.
- A session whose agent never compacts can still hit the context limit.
- Compaction is irreversible: the full history before it is not stored. Execution history keeps per-turn usage, not the cleared content.
- Compaction rewrites the prefix, so the next turn misses the cache from the first changed message. The system prompt survives, so its cache entry stays valid.
- On Anthropic, only tools and the system prompt are cached; later history is resent at full input price each turn.
- Any change to the system prompt context (a setting, a new background task, the daily date) misses the cache once.
- Provider adapters must not rely on message positions: DeepSeek reasoning replay pairs by tool-call id because compaction shifts them.

## Alternatives considered

- **Automatic size-triggered compaction**: needs per-model context sizes and can cut mid-task; deferred, see the PRD.
- **Sliding-window truncation**: drops decisions and can orphan tool calls.
- **Compaction inside the tool**: the tool has no access to the messages and would run before the turn commits.
- **A dedicated summarizer model**: another provider key and quota, outside the workspace's chosen model.
- **Uniform caching config for all providers**: each provider exposes caching differently, so it stays a per-provider registry entry.

## Notes

- Related: [prd-context-compaction.md](../../../prd/accepted/prd-context-compaction.md), [system prompt rebuilt per run](../agent/adr-system-prompt-rebuilt-per-request.md), [model gateway](../agent/adr-model-gateway-provider-layer.md), [run loop and run broker](../agent/adr-agent-run-loop-and-run-broker.md).
