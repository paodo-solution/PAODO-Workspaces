# ADR — Chokidar + WebSocket for live workspace file updates

Status: Accepted

## Context

The browser UI needs to reflect filesystem changes made by the agent in real time — new files in the tree and updated content in the viewer. The challenge is bridging the server-side filesystem to the browser without polling, and doing so per-workspace so events are not leaked across workspaces.

Next.js API routes cannot push events to the browser on their own; they are stateless request handlers. A persistent server-to-client channel is needed.

## Decision

A custom Node.js server (`server.ts`) handles `/ws` upgrades itself, after a host, origin and credential check, and leaves every other upgrade to Next.js. The WebSocket shares the app's port, and each socket joins one workspace's broadcast group.

The first socket to join a workspace starts a chokidar watcher on its directory; the watcher stops after a short grace period once the last socket leaves. The watcher batches events into `files_changed` and `files_deleted` messages, re-checks deletions to tell a move from a delete, and skips the echo of a file the user just saved in the UI. Agent file tools also broadcast `files_changed` directly, so their writes appear without waiting for the watcher.

The connection registry lives on the Node.js `global` object so it survives hot reloads (see [global-object-hot-reload-survival](adr-global-object-hot-reload-survival.md)).

On the client, the workspace page owns one socket and fans events out: the file tree re-fetches, and the open file reloads unless it has unsaved edits, or closes if it was deleted.

## Consequences

- The tree and the open file update while the agent works, with no user action.
- Unsaved edits are never overwritten by a reload.
- The same socket carries other workspace events (`conversations_changed`, `background_tasks_changed`).
- A watcher runs only while a tab is open on its workspace.
- `DISABLE_WS_FILE_WATCH=1` disables all watchers for environments where chokidar is unsupported.

## Alternatives considered

- **Client polling**: simple but introduces latency proportional to the poll interval and wastes requests when nothing changes.
- **SSE (Server-Sent Events)**: one-way, so the client's `self_write` message would need a separate request.
- **Next.js Route Handlers with SSE**: cannot share state with the filesystem watcher without the global-object workaround; also conflicts with the WebSocket upgrade handling already needed.

## Notes

- Related PRD: [prd-live-workspace-file-updates.md](../../../prd/accepted/prd-live-workspace-file-updates.md)
