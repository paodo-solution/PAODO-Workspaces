# ADR — Upload & workspace file layout

Status: Accepted

## Context

Each workspace needs a place on disk for its files, mounted into its container, and users need to upload files into it — from single documents to whole folders of several gigabytes — without escaping the workspace, exhausting memory, or filling the disk.

## Decision

Workspace files live on local disk at `<root>/<workspace-id>`, where the root is `data/` by default and configurable with `WORKSPACES_ROOT`. The workspace list is kept in `<root>/.workspaces.json`.

Uploads use one shared handler (`lib/uploads/upload.ts`) for workspaces and drives:

- **One file per request** at `POST /api/workspaces/<id>/files/upload?path=…`; a folder upload is one request per file. The CLI moves whole trees through a separate tar endpoint (`files/transfer`).
- **Streamed to disk**, never buffered in memory: the body is written to a temporary `.part` file next to its destination and renamed into place only when complete.
- **Contained**: the target path is resolved against the real path of the workspace folder, and anything outside it is rejected.
- **Bounded**: 1 GB per file, checked against the declared size before reading and against the actual bytes while streaming. A CLI transfer is capped at 8 GB and 100,000 entries.
- **Disk-aware**: an upload is refused when it would leave less than 1 GB free.
- **Rate-limited** per workspace.

A workspace upload then takes a git snapshot of the workspace; a burst of uploads is grouped into one commit, so it can be undone.

## Consequences

- The on-disk layout is easy to inspect, back up, and mount into containers.
- Uploads of any size keep memory flat, and an interrupted upload never leaves a half-written file in place. A background sweeper deletes `.part` files left behind if the server dies mid-upload.
- Uploads are undoable through workspace history.
- Storage is limited to the VPS disk: no external durability, quotas across servers, or malware scanning.

## Alternatives considered

- **External object storage (S3/GCS)**: deferred; local disk is what containers mount and what a single VPS needs.
- **ZIP upload extracted on the server**: rejected; one request per file keeps memory flat and makes each file's limit and path check independent.

## Notes

- Files: `lib/uploads/upload.ts`, `lib/uploads/limits.ts`, `lib/uploads/sweeper.ts`, `app/api/workspaces/[id]/files/upload/route.ts`.
