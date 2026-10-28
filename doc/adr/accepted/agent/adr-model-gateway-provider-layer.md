# ADR — Single model gateway over provider protocol adapters

Status: Accepted

## Context

Workspaces run on several LLM providers that differ in reasoning settings, streaming format, rate-limit headers, usage reporting and error wording. Provider keys are deployment-wide, so all runs share one quota per provider. Pacing, retries and usage accounting must hold for every model call, and vendor quirks must stay out of the run loop and stored history.

## Decision

Every model call goes through one `ModelGateway` (`lib/agent/modelGateway.ts`), built only by `buildModel` (`lib/agent/buildModel.ts`). Callers never hold a vendor client.

```
runner / compaction → ModelGateway → [pacing → retry → outbound adapter] → LangChain client → provider
```

- **Provider registry**: `PROVIDERS` in `buildModel.ts` is the single list of supported providers. A provider is offered only when `<PROVIDER>_AVAILABLE=true`. Models and effort levels live in `lib/models/registry.ts`.
- **Protocol adapters**: vendor-specific behaviour lives in `<provider>Protocol.ts` and plugs in at request fields, response parsing or outbound history. Standard providers need no adapter.
- **Provider-neutral history**: reasoning is stored as plain text tagged with its author, and sent back only to the provider that wrote it.
- **Per call**: one shared rate-limit pacer per provider and model, bounded retries on rate limits only (never after output has streamed), normalized token usage reported to an observer, and stable failure codes (`providerFailure.ts`).

## Consequences

- The run loop sees one interface; adding a provider is a registry entry, its models and prices, and an adapter only if needed.
- Every call, compaction included, is paced and accounted for.
- A conversation can switch provider without rewriting history.
- Pacing state is in-process, which ties this to single-instance deployment.
- Adapters rely on LangChain internals; protocol tests catch breaking upgrades.

## Alternatives considered

- **Each call site handles its own call**: duplicated pacing and accounting that drift.
- **Vendor SDKs directly**: streaming and tool parsing duplicated per provider.
- **External gateway service**: an extra hop holding keys, with no control over reasoning replay.
- **SDK built-in retries**: hidden from the pacer and blind to the shared quota.

## Notes

- Related: [run loop and run broker](adr-agent-run-loop-and-run-broker.md), [execution data in SQLite](adr-conversation-and-execution-data-sqlite.md), [provider key vault](../access/adr-provider-key-vault.md), [context compaction and prompt caching](adr-context-compaction-prompt-caching.md).
