# ADR — Conversation replay and execution history share one versioned SQLite database

Status: Accepted

## Context

The application keeps two kinds of durable data:

- **Conversation replay**: the messages an agent needs to resume a chat.
- **Execution history**: what each run did and consumed (tokens, cost, output, tool calls), used by the monitoring dashboard and the chat token display.

Both must survive restarts, be ready at startup, and be backed up together. But they answer different questions — "what must the model replay?" versus "what ran and what did it cost?" — and have different lifecycles. Both also contain sensitive plaintext: prompts, file contents, command output, or secrets the agent came across.

## Decision

Store both in separate tables of one SQLite database, `.paodo.db` in the data root (`data/` by default):

- `conversations` holds replayable messages.
- `sessions` holds one record per run; `turns` holds one record per model call with its tokens, cost and tool calls.

`sessions` links to a conversation by id, without a foreign key, so execution history survives conversation deletion. Replay messages keep only the turn id needed to display tokens, never a second copy of them.

`lib/data/database.ts` owns the connection. Schema changes are forward-only migrations in `lib/data/migrations/`, applied in one transaction at startup; startup fails if a migration fails or the database comes from a newer app version.

Content is stored unredacted. Confidentiality relies on the single-user deployment's authentication and network boundaries.

## Consequences

- Opening the database guarantees both schemas are ready, and one backup captures both consistently.
- Token data has one source of truth: chat replay cannot become it, and dashboard cleanup cannot break replay.
- Deleting a conversation keeps its execution history.
- Shipped migrations must never be edited; schema changes need a new one.
- The database grows with use; retention is an operator decision.
- Anyone with host access can read sensitive plaintext. A multi-user deployment would need per-workspace authorization and redaction or encryption at rest.

## Alternatives considered

- **Separate SQLite files for conversations and usage**: migrations, readiness and backup would have several owners, with no gain in durability.
- **Execution data inside conversation messages**: token data would have two sources of truth, monitoring would depend on chat retention, and non-chat runs would not fit.
- **One table for both**: they have different identities, lifecycles and query patterns.
- **Per-workspace JSON and JSONL files**: duplicates write and recovery logic, weakens transactions, and makes dashboard queries harder.
- **Redacting stored content**: reliable secret detection is unavailable and redaction removes debugging value. Revisit if the threat model changes.

## Notes

- Related PRDs: `doc/prd/accepted/prd-persistent-conversations.md`, `doc/prd/accepted/prd-monitoring-dashboard.md`.
- Backups: the database is part of the full backup set (`npm run backup`, see `doc/backup-restic.md`).
