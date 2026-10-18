// Fire-and-forget snapshot after user file changes. Takes the versioning service as an argument to stay out
// of the services import graph.
import type { IWorkspaceSnapshotWriter } from "../interfaces";
import { createLogger } from "../logger";

const log = createLogger("api");

export interface SnapshotResult {
  sha: string;
  changed: boolean;
}

// For a response that promises a durable revision: failures propagate, so a transfer receipt never
// claims a restore point it did not create.
export function snapshotWorkspaceStrict(
  versioning: IWorkspaceSnapshotWriter,
  ws: { id: string; dir: string },
  label: string,
): Promise<SnapshotResult> {
  return versioning.commitResult(ws.id, ws.dir, label);
}

// Fire-and-forget: a versioning failure never fails the user's action; no-op if nothing changed.
export async function snapshotWorkspace(
  versioning: IWorkspaceSnapshotWriter,
  ws: { id: string; dir: string },
  label: string,
): Promise<void> {
  try {
    await snapshotWorkspaceStrict(versioning, ws, label);
  } catch (err) {
    log.warn({ err, workspaceId: ws.id }, "versioning snapshot failed");
  }
}

// Run just before a batch transfer: separates a pending browser upload burst from the transfer and
// surfaces a failed pre-transfer snapshot.
export async function flushSnapshotBurstStrict(
  versioning: IWorkspaceSnapshotWriter,
  ws: { id: string; dir: string },
): Promise<SnapshotResult | null> {
  const burst = pending.get(ws.id);
  if (!burst) return null;
  clearTimeout(burst.timer);
  pending.delete(ws.id);
  return snapshotWorkspaceStrict(versioning, ws, burst.label(burst.changes, burst.firstChange));
}

// A folder upload is one request per file, and each snapshot stages the whole tree, so coalesce bursts;
// 2s still updates history while the user watches.
const COALESCE_MS = 2_000;

interface Burst {
  timer: NodeJS.Timeout;
  changes: number;
  firstChange: string;
  /** Kept with the burst so a flush produces the same message the timer would have. */
  label: (changes: number, firstChange: string) => string;
}

const pending = new Map<string, Burst>();

// Each call restarts the timer, so a burst commits once; `label` gets the count and first name. Unref'd:
// a snapshot lost at shutdown is picked up by the next one, since commitResult stages everything.
export function snapshotWorkspaceCoalesced(
  versioning: IWorkspaceSnapshotWriter,
  ws: { id: string; dir: string },
  change: string,
  label: (changes: number, firstChange: string) => string,
): void {
  const existing = pending.get(ws.id);
  if (existing) clearTimeout(existing.timer);

  const changes = (existing?.changes ?? 0) + 1;
  const firstChange = existing?.firstChange ?? change;
  const timer = setTimeout(() => {
    pending.delete(ws.id);
    void snapshotWorkspace(versioning, ws, label(changes, firstChange));
  }, COALESCE_MS);
  timer.unref();

  pending.set(ws.id, { timer, changes, firstChange, label });
}

// Commits the pending burst now, for a caller that knows it sent its last file and needs one commit
// done before replying. Returns whether anything was pending, so it never reports a phantom snapshot.
export async function flushSnapshotBurst(
  versioning: IWorkspaceSnapshotWriter,
  ws: { id: string; dir: string },
): Promise<boolean> {
  const burst = pending.get(ws.id);
  if (!burst) return false;
  clearTimeout(burst.timer);
  pending.delete(ws.id);
  await snapshotWorkspace(versioning, ws, burst.label(burst.changes, burst.firstChange));
  return true;
}
