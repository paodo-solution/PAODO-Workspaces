// Helpers for drive_* tools: resolves (drive_name, path) to a contained host path, only for drives connected
// to this workspace. Host-side only.
import path from "path";
import fs from "fs/promises";
import { normalizeRelpath } from "./pathUtils";
import { toolError } from "./toolUtils";
import { formatOutputBytes } from "@/lib/infra/limits";
import { resolveDriveDir, type Drive } from "@/lib/drives/store";
import { buildTree, type TreeNode } from "@/lib/files/tree";

export interface ResolvedDrivePath {
  drive: Drive;
  driveDir: string;
  /** Absolute host path of the target inside the drive (equals driveDir when relPath is empty). */
  absPath: string;
  /** The normalized relative path within the drive (may be ""). */
  relPath: string;
}

// Returns a resolved path, or an "Error: ..." string suitable for returning straight from a tool.
export function resolveDrivePath(workspaceId: string, driveName: string, relPath?: string): ResolvedDrivePath | string {
  const resolved = resolveDriveDir(workspaceId, driveName);
  if (!resolved) return `Error: no drive named "${driveName}" is connected to this workspace`;

  let rel = "";
  if (relPath && relPath !== "." && relPath !== "/") {
    const norm = normalizeRelpath(relPath.replace(/^\/+/, ""));
    if (norm === null) return "Error: path is outside the drive";
    rel = norm;
  }
  return {
    drive: resolved.drive,
    driveDir: resolved.dir,
    absPath: rel ? path.join(resolved.dir, rel) : resolved.dir,
    relPath: rel,
  };
}

// Host-side reads skip every container limit, so this bounds them; it refuses rather than truncates,
// since a half-copied file reports success. The read is capped too, in case the file grows after stat.
export async function readFileBounded(
  absPath: string,
  limit: number,
  labels: { missing: string; isDirectory: string; advice: string },
): Promise<Buffer | string> {
  let handle;
  try {
    const stat = await fs.stat(absPath);
    if (stat.isDirectory()) return labels.isDirectory;
    if (stat.size > limit) {
      return (
        `Error: file is ${formatOutputBytes(stat.size)}, over the ${formatOutputBytes(limit)} limit for this tool. ` +
        labels.advice
      );
    }

    handle = await fs.open(absPath, "r");
    // Read one byte past the stat size so a growing file reads as changed, not silently short.
    const expected = Math.min(stat.size, limit);
    const buf = Buffer.alloc(expected + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > expected) {
      // Being written right now: copying a torn read would report success over a corrupt file.
      return `Error: "${path.basename(absPath)}" changed while being read — it is being written to. Try again once the write has finished.`;
    }
    return buf.subarray(0, bytesRead);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return labels.missing;
    if (e.code === "EISDIR") return labels.isDirectory;
    return toolError(e);
  } finally {
    await handle?.close();
  }
}

// Files under `absDir` for a folder transfer, with the shared ignore rules. No count cap: each file is
// bounded on transfer, so heap use never exceeds the largest file.
export async function enumerateDriveFolder(absDir: string): Promise<string[]> {
  const { nodes } = await buildTree(absDir, { maxDepth: Infinity });
  const files: string[] = [];
  collectFiles(nodes, files);
  return files;
}

function collectFiles(nodes: TreeNode[], out: string[]): void {
  for (const node of nodes) {
    if (node.type === "directory") collectFiles(node.children ?? [], out);
    else out.push(node.path);
  }
}

// Summarizes a transfer, listing each failed file instead of aborting. Leads with `Error:` when nothing
// moved, so the agent can't read a total failure as success.
export function formatFolderTransfer(
  verb: string,
  moved: number,
  bytes: number,
  target: string,
  skipped: string[],
): string {
  const skipClause = skipped.length ? `Skipped ${skipped.length}: ${skipped.join("; ")}` : "";
  if (moved === 0) {
    return `Error: nothing transferred to ${target} — all ${skipped.length} file${skipped.length === 1 ? "" : "s"} failed. ${skipClause}`;
  }
  const head = `${verb} ${moved} file${moved === 1 ? "" : "s"} to ${target} (${formatOutputBytes(bytes)})`;
  return skipClause ? `${head}. ${skipClause}` : head;
}

// Collapse a tool's verbose `Error: ...` string to its first sentence, for listing many skips compactly.
export function compactError(message: string): string {
  const stripped = message.replace(/^Error:\s*/, "").trim();
  const end = stripped.indexOf(". ");
  return end === -1 ? stripped : stripped.slice(0, end);
}
