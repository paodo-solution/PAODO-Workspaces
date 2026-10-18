// Every app-side memory ceiling, in one place so it's visible whether every accumulating path is bounded.
// Not env knobs (doc/security_notes.md); the app container has no memory limit, so these ARE the limit.

/** Byte size for a ceiling's message ("29.4KB", "1.2MB"), so every cut or refusal says how big it was. */
export function formatOutputBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value}B` : `${(Math.round(value * 10) / 10).toFixed(1)}${units[unit]}`;
}

// ---- Subprocess capture — lib/infra/spawnCapture.ts (docker + git) ----

// Per-stream safety floor for any spawned child, far above legitimate git/docker output, so an unbounded
// `stdout +=` can never throw RangeError from a stream handler. Tools set lower bounds of their own.
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

// ---- Command output — lib/agent/tools/execOutput.ts, execCommand.ts ----

/** Output at or under this stays inline in the tool result, whole. Matches Claude Code's threshold. */
export const MAX_INLINE_BYTES = 30_000;

/** How much of an over-cap output is shown inline, as a head preview. Claude Code shows 2KB. */
export const PREVIEW_BYTES = 2_048;

// Stderr kept from each end of a spilled output, so diagnoseStderr still sees setup faults (head) and
// a build's final error (tail).
export const STDERR_SAMPLE_BYTES = 2_048;

// ---- Spill files — lib/infra/docker/containerManager.ts ----

// Ceiling on one spill file, so one command can't fill the container's writable layer (which the mid-run
// disk check, watching the workspace mount, can't see).
export const EXEC_OUTPUT_MAX_BYTES = 20 * 1024 * 1024;

// Spill files kept per container: 5 × 20MB = a deliberate 100MB budget in a layer that is never
// recreated. The agent only greps the file it was just handed.
export const EXEC_OUTPUT_KEEP = 5;

// Bytes queued for a slow sink before the file stops at a prefix, so the backlog never sits in the app's heap.
export const EXEC_OUTPUT_MAX_BACKLOG = 8 * 1024 * 1024;

// SIGTERM grace before SIGKILL, so git and npm can clean up (index.lock, staging dirs). Nothing waits on
// it: the kill is already fire-and-forget.
export const EXEC_KILL_GRACE_MS = 2_000;

// Backstop for the apt recipe replay, which every command waits on and `docker exec` can't time out.
// Minutes, so a slow mirror installing a toolchain finishes and only a real stall is cut.
export const APT_REPLAY_TIMEOUT_MS = 5 * 60_000;

// How long installing the egress relay into an older container may hold up its wake before the
// container carries on with its own proxy settings. One tiny package; only a stall reaches this.
export const PROXY_RELAY_INSTALL_TIMEOUT_MS = 2 * 60_000;

// ---- File reads — lib/agent/tools/fileRead.ts, lib/agent/tools/driveRead.ts ----

// Max bytes one `file_read` or `drive_read` pulls in, sized for LLM context; page past it with
// offset/limit. Enforced before reading (`head -c` in the container, a host-side stat), never after.
export const MAX_FILE_READ_BYTES = 400_000;

// ---- Drive transfers — lib/agent/tools/driveDownload.ts, driveUpload.ts, driveLs.ts ----

// Ceiling on one file moved to or from a drive. Peak heap is ~3.7× the file (raw + base64 + stdin copy),
// so 100MB costs ~370MB. Folders move file by file, so the peak doesn't grow.
export const MAX_DRIVE_TRANSFER_BYTES = 100 * 1024 * 1024;

/** Entries `drive_ls` reads and renders per directory; bounds both the scan and the listing text. */
export const MAX_DRIVE_LISTING_ENTRIES = 1_000;

// ---- Live console sockets — lib/infra/realtime/wsHub.ts ----

// Backlog after which a socket gets no more output. The panel keeps 500 lines, so dropped output was
// already out of view; drops are reported (console_dropped).
export const WS_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

// A socket pinned at the ceiling this long is dead (no FIN), so it is terminated; a live viewer reconnects and resyncs.
export const WS_STALL_MS = 30_000;
