// Reclaims ".part" upload temp files leaked when the process dies mid-upload. Same in-process tick as
// scheduler.ts.
import type { Dirent } from "fs";
import { createLogger } from "../infra/logger";
import { globalSingleton } from "../infra/globalSingleton";
import { WORKSPACES_ROOT } from "../infra/paths";
import { withDir, type RootedDir } from "../files/rootedFs";

const log = createLogger("uploadSweeper");

const DEFAULT_TICK_MS = 30 * 60_000;
// Comfortably longer than server.ts's request timeout for uploads, so a sweep can never catch a
// file that is still genuinely being written.
const DEFAULT_STALE_MS = 2 * 60 * 60_000;

// Matches the temp file name upload.ts creates: `${resolved}.${randomBytes(6).toString("hex")}.part`.
const PART_FILE = /\.[0-9a-f]{12}\.part$/;

type SweeperState = { timer: NodeJS.Timeout | null; running: boolean };
const state = globalSingleton<SweeperState>("uploadSweeperState", () => ({ timer: null, running: false }));

// Walks through rootedFs, so a directory swapped for a link mid-sweep is refused rather than swept.
async function removeStaleParts(dir: RootedDir, staleBeforeMs: number): Promise<number> {
  let removed = 0;
  let entries: Dirent[];
  try {
    entries = await dir.entries();
  } catch (err) {
    log.warn({ err, dir: dir.relPath }, "upload sweep could not read directory");
    return removed;
  }

  for (const entry of entries) {
    if (entry.name === ".git") continue; // never touched by uploads; walking it is pure cost
    if (entry.isDirectory()) {
      removed += await sweepChild(dir, entry.name, staleBeforeMs);
      continue;
    }
    if (!entry.isFile() || !PART_FILE.test(entry.name)) continue;
    try {
      const stat = await dir.lstat(entry.name);
      if (!stat.isFile() || stat.mtimeMs > staleBeforeMs) continue;
      await dir.unlink(entry.name);
      removed += 1;
    } catch (err) {
      log.warn({ err, file: dir.childRel(entry.name) }, "upload sweep could not remove stale temp file");
    }
  }
  return removed;
}

async function sweepChild(dir: RootedDir, name: string, staleBeforeMs: number): Promise<number> {
  let child: RootedDir;
  try {
    child = await dir.openDir(name);
  } catch (err) {
    log.warn({ err, dir: dir.childRel(name) }, "upload sweep could not read directory");
    return 0;
  }
  try {
    return await removeStaleParts(child, staleBeforeMs);
  } finally {
    await child.close();
  }
}

async function tick(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    const staleMs = parseInt(process.env.UPLOAD_SWEEP_STALE_MS ?? String(DEFAULT_STALE_MS), 10) || DEFAULT_STALE_MS;
    const staleBefore = Date.now() - staleMs;
    const removed = await withDir(WORKSPACES_ROOT, "", (root) => removeStaleParts(root, staleBefore));
    if (removed > 0) log.info({ removed }, "upload sweep removed orphaned temp files");
  } catch (err) {
    log.warn({ err }, "upload sweep tick failed");
  } finally {
    state.running = false;
  }
}

/** Start the sweep loop. Idempotent. */
export function startUploadSweeper(): void {
  if (state.timer) return;
  const tickMs = parseInt(process.env.UPLOAD_SWEEP_TICK_MS ?? String(DEFAULT_TICK_MS), 10) || DEFAULT_TICK_MS;
  state.timer = setInterval(tick, tickMs);
  state.timer.unref?.();
  log.info({ tickMs }, "upload sweeper started");
}

export function stopUploadSweeper(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
  log.info("upload sweeper stopped");
}

// Exported for tests to drive a single sweep deterministically.
export { tick as _tick };
