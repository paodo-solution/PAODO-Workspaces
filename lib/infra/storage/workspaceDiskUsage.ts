// A workspace's on-disk size: its tree, .homes/<id> and .versioning/<id>, via `du`, briefly cached; a missing
// directory counts 0.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { WORKSPACES_ROOT, workspaceHomeDir } from "@/lib/infra/paths";

const run = promisify(execFile);
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; usage: WorkspaceDiskUsage }>();

export interface WorkspaceDiskUsage {
  workspaceId: string;
  bytes: number;
  breakdown: { workspace: number; home: number; versioning: number };
}

// `du -sk` reports usage in 1024-byte blocks and is portable across GNU and BSD `du`, unlike `-b`.
// A missing or unreadable path makes `du` exit non-zero, which we treat as 0.
async function du(dir: string): Promise<number> {
  try {
    const { stdout } = await run("du", ["-sk", "--", dir]);
    return (Number.parseInt(stdout, 10) || 0) * 1024;
  } catch {
    return 0;
  }
}

export async function getWorkspaceDiskUsage(
  workspaceId: string,
  root: string = WORKSPACES_ROOT,
): Promise<WorkspaceDiskUsage> {
  const key = `${root}\0${workspaceId}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.usage;

  const [workspace, home, versioning] = await Promise.all([
    du(path.join(root, workspaceId)),
    du(workspaceHomeDir(workspaceId, root)),
    du(path.join(root, ".versioning", workspaceId)),
  ]);
  const usage: WorkspaceDiskUsage = {
    workspaceId,
    bytes: workspace + home + versioning,
    breakdown: { workspace, home, versioning },
  };
  cache.set(key, { at: Date.now(), usage });
  return usage;
}
