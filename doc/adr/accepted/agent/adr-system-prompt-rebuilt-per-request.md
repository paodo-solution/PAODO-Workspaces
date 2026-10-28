# ADR — System prompt rebuilt at the start of every run

Status: Accepted

## Context

The agent's system prompt combines fixed platform instructions with the workspace's current state: its `AGENTS.md` instructions, model settings, internet access (on, off, or restricted to listed domains), attached drives, secret names, and background tasks. Users change these at any time, and the agent must act on the current values — for example, not attempt `curl` once internet access is off.

## Decision

The system prompt is rebuilt from current state at the start of every run, never cached: chat, API, scheduled runs, and agent-to-agent skill calls all go through `refreshWorkspaceSystemPrompt` (`lib/agent/workspacePrompt.ts`).

The prompt is stored as the first message of the conversation and replaced at each run, so a conversation always carries the latest prompt, never an outdated one. It stays fixed for the duration of a run.

## Consequences

- Changes to `AGENTS.md` or workspace settings take effect on the next run, with no restart or new conversation.
- Building the prompt costs a few small file reads per run.
- Provider prompt caching still applies: an unchanged prompt is served from cache. A change (an edit, a setting, a new background task, or the date changing daily) misses the cache once for that run.
- Each run's exact system prompt is recorded in the execution history, so what the agent was told on any past run can be reviewed.

## Alternatives considered

- **Cache the prompt at conversation start**: the agent would act on outdated settings until a restart or a new conversation.
- **Append each run's prompt to the history**: earlier, outdated prompts would stay in the context and contradict the current one.
