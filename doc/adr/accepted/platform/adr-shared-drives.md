# ADR — Shared drives across workspaces

Status: Accepted

## Context

Each workspace is an isolated container with its own volume. Agent-to-agent calls carry text, not files. So in a pipeline where one agent researches, another writes and a third executes, the agents have nowhere to pass files to each other. Users had to copy outputs between workspaces by hand.

We need a shared file space that several workspaces can use without weakening container isolation.

## Decision

**A drive is passive host storage, never mounted into a container.** Its content lives in `<root>/.drives/<driveId>/`, keyed by UUID so that renaming a drive never moves its files. Two JSON files sit next to the workspace registry: the drive registry (`.drives.json`) and the drive↔workspace links (`.drive-connections.json`). They are separate from the agent-call graph, saved atomically and read fresh on every access (`lib/drives/store.ts`).

**A connection is the access grant.** A user connects a drive to a workspace by drawing an edge in the graph UI. A workspace can reach only the drives connected to it: `resolveDriveDir` matches an id, or a case-insensitive name, against that set and nothing else. Every connection is read-write.

**Agents use host-side tools and work on copies.** The app process runs five tools: `drive_ls`, `drive_read`, `drive_download`, `drive_upload` and `drive_delete`. They are registered, along with a "Connected drives" block in the system prompt, only when at least one drive is connected. Both are rebuilt on every run, so a new connection takes effect on the next run and no container restart is needed. The model works like a local machine next to a network share:

- `drive_download` copies a file or folder to `downloads/<drive-name>/<path>` in the workspace, where the agent's usual tools can work on it.
- `drive_upload` pushes results back to the drive.
- When an agent hands work to another agent, it passes the drive id and the file path, not the file's contents.

**A drive behaves like a plain filesystem.** Each path holds one file, and the newest write wins. There is no locking and no history. When an upload overwrites an existing file, the tool result says so, and a delete is final.

**Paths, names and sizes are bounded.**

- Paths inside a drive are checked lexically.
- Download destinations are checked against the real path of the workspace, so a symlink cannot escape it.
- A drive name becomes a directory, so it may not contain path separators, may not start with a dot, and must be unique ignoring case.
- Host-side I/O avoids every container limit, so each tool has its own ceiling: 400 KB per `drive_read`, 100 MB per transferred file (folders move one file at a time) and 1,000 entries per `drive_ls` listing.
- A tool refuses an over-limit request instead of truncating it, because a partly copied file would look like a success.

**People and the CLI use the same file layer as workspaces.** The routes under `/api/drives/<id>/files…` reuse the workspace file-tree, upload and tar-transfer code through a `FileBackend` that points at the drive directory. That backend has no git-snapshot hook. Drive writes use the same upload rate limit as workspaces. The platform access policy gives drives the same file methods as workspaces and no more.

**Lifecycle and backup.**

- Deleting a drive removes its content first, then its connections, then its registry entry. The registry entry stays to the end so that a failed delete can be retried.
- Deleting a workspace removes its connections.
- Backups take the registry, the connections and all content as one drives archive, and a restore replaces all three together.

## Consequences

- Container isolation is unchanged. No container shares a mount, and shell commands inside a container cannot reach a drive. The only way in is the agent's own tool calls, checked against its connections.
- Drives are plain directories, so they are easy to inspect, browse in the UI (the workspace file tree and viewer are reused) and back up.
- Copies use workspace disk and can go stale. The prompt tells agents to delete their local copy after uploading and to empty `downloads/` before ending their turn, but nothing enforces it.
- Drive I/O runs in the app's heap, which is why the size ceilings exist. Larger files must be split before they are moved.
- Concurrent agents can overwrite each other's files, and an overwritten or deleted file cannot be recovered.
- Any connected workspace can read, overwrite or delete anything on the drive. The only scoping is per drive: connect a separate drive.
- The JSON registry assumes a single app instance (see `adr-single-instance-in-process-state`).

## Alternatives considered

- **Bind-mounting the drive into each connected container**: every connect or disconnect would mean recreating containers. It would also let several shells write to the same live files at once, and it would add a host path shared across sandboxes, which isolation is meant to prevent.
- **Passing file contents in agent-to-agent messages**: this fills the context window, cannot carry binary files and is lost after the call.
- **Object storage (S3)**: deferred for the same reason given in the upload ADR. Local disk is all a single VPS needs.
- **Making drives nodes in the agent-call graph**: rejected. An agent edge means "may call", while a drive edge means "may read and write files", so the two are stored separately.
## Notes

- PRD: `doc/prd/accepted/prd-shared-drives.md`.
- Code:
  - `lib/drives/` (store, naming, archive members)
  - `lib/agent/driveAccess.ts`
  - `lib/agent/tools/drive*.ts`
  - `lib/agent/promptContext.ts` (`buildDrivesInfo`)
  - `lib/operations/drives/`
  - `app/api/drives/`
  - `app/api/drive-connections/`
  - `lib/infra/drives/` (backup and restore)
- Related: `adr-container-per-workspace-sandbox`, `adr-upload-folder-file-architecture`, `adr-backup-set-restic-offsite`.
