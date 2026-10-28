# ADR — Git versioning of workspaces

Status: Accepted

## Context

Agents and users change workspace files constantly: agent runs, browser edits and uploads, CLI pushes. A run can go wrong and leave a broken tree, so the owner and the agent both need to see what changed and roll back. The agent may also use git itself inside `/workspace`, and it must not be able to read, rewrite or delete the platform's history.

## Decision

The platform snapshots each workspace with git, in a repo the agent cannot reach (`WorkspaceVersioning`, `lib/infra/git/`).

- **Repo outside the tree.** The git-dir is `<WORKSPACES_ROOT>/.versioning/<id>` and every command passes `--git-dir` and `--work-tree` explicitly. Only the workspace dir is bind-mounted into the container, so the history never appears there. The repo is keyed by workspace id, so renames don't affect it. Commits use a fixed identity and never read the host's git config.
- **Full snapshots.** `add --all --force` with `core.excludesFile=/dev/null` ignores every ignore rule, so a snapshot is the whole tree. The agent's own `.git` is skipped, and a nested repo is stored as a gitlink.
- **When snapshots are taken:**
  - Workspace creation: an `init` commit (allowed empty) as the baseline, best-effort.
  - Agent run: `commitBaseline` before the run (`pre-run (user prompt): …`) and `commitResult` in the runner's `finally`, so aborted runs are also captured. The result commit is tagged `run/<n>`, where `n` is counted from the existing tags so it survives restarts.
  - User edits: a file save commits once; browser uploads are grouped into one commit per 2 s burst.
  - CLI `PUT .../files/transfer`: committed strictly, so a push reports failure if it left no restore point.
  - No commit when nothing changed.
- **Never blocks the action.** Run and edit snapshots are try/caught and only logged. Because of that, the server refuses to start if `git` is missing, otherwise history would stop without anyone noticing.
- **Serialized per workspace.** Every write to the repo goes through one promise chain per workspace, so concurrent runs and uploads cannot race on the git index.
- **Restore = `reset --hard <sha>`.** The sha is checked against `isSnapshotSha` and `rev-parse --verify`. Restores are recorded in the audit log.
  - UI: History panel → `GET /api/workspaces/<id>/history`, `GET .../diff?from&to`, `POST .../restore`.
  - Agent: `workspace_history` reads snapshots and diffs in-process (diffs capped and paged). `workspace_restore` is a signal tool: it only validates the sha, and the runner does the reset after the turn.
- **History reads use `log --all`.** Snapshots after the restored one stay visible through their `run/*` tags, so a user can move forward again.
- **Lifecycle.** Deleting a workspace deletes its git-dir. A workspace archive carries the history as a `git bundle --all`, and applying the archive rebuilds the git-dir and checks HEAD out into the tree. Disk usage reports history as its own line.

## Consequences

- Every run, edit and push can be inspected and undone, from the UI or by the agent itself.
- The agent can use git freely without affecting the platform's history, and it cannot tamper with it.
- Restore only rolls back files, not side effects such as sent emails or API calls already made. It discards any change made since the last snapshot.
- After a restore, snapshots without a `run/*` tag (uploads, edits) that came after the target can no longer be reached from history.
- Files inside a nested git repo are not versioned, only its commit pointer is.
- Every snapshot stages the whole tree, and history grows without limit, so large or binary-heavy workspaces cost disk and time. Nothing prunes or garbage-collects the repo yet.
- One repo per workspace, guarded by in-process locks, assumes a single app instance (see the single-instance ADR).

## Alternatives considered

- **Git-dir inside the workspace (`/workspace/.git`)**: collides with the agent's own git and lets the agent rewrite history.
- **Filesystem/volume snapshots (btrfs, ZFS, LVM)**: depends on the host's storage and gives no per-file diff the agent can read.
- **Copying the tree per run**: no diffs, no deduplication, and storage grows with every run.
- **Respecting `.gitignore`**: snapshots would silently miss files the user or agent chose to ignore.
- **Failing the action when a snapshot fails**: versioning would be able to break runs and edits. Only CLI pushes, which promise a restore point, fail strictly.

## Notes

- Code: `lib/infra/git/workspaceVersioning.ts`, `lib/infra/git/snapshotWorkspace.ts`, `lib/agent/runner.ts`, `lib/agent/tools/workspaceHistory.ts`, `lib/agent/tools/workspaceRestore.ts`, `lib/operations/workspace/restore.ts`.
- Related ADRs: [Container per workspace](../sandbox/adr-container-per-workspace-sandbox.md), [Single-instance in-process state](../platform/adr-single-instance-in-process-state.md), [Backup set via restic](../platform/adr-backup-set-restic-offsite.md).
