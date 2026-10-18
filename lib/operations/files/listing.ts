// Lists one directory of a workspace or drive (walk in lib/files/tree.ts). Resolves the caller's path and maps
// errnos, so a bad path is an error rather than an empty tree.

import fs from "fs/promises";
import path from "path";
import { buildTree, type TreeNode } from "@/lib/files/tree";
import { openFileLimiter, type Semaphore } from "@/lib/files/fdLimit";
import { countLines, readFileEntry } from "./content";
import { fileSystemCall } from "./errors";
import { requireDirPath, resolveHostPath } from "./paths";

// Largest file a listing reads to count lines, so a huge log isn't read just to list names. Bigger files
// get no `lines`.
const MAX_MEASURED_BYTES = 4 * 1024 * 1024;

export interface ListEntriesOptions {
  /** Levels to descend, counted from the directory listed. Infinity walks all of it. */
  maxDepth?: number;
  // Adds `lines` to small text files, at one read per file, for windowed readers (`file cat --offset`).
  // Off by default; the file panel never asks.
  measure?: boolean;
  // Adds a recursive file count to each directory, at the cost of walking the subtree. Off by default;
  // for callers deciding where to descend.
  countFiles?: boolean;
  // Per-directory entry cap, bounding breadth as `maxDepth` bounds depth; `truncated` reports a hit.
  // Absent means no cap, which the file panel relies on.
  maxEntries?: number;
}

/** A listing, and whether the ceiling cut any part of it short. */
export interface Listing {
  tree: TreeNode[];
  truncated: boolean;
}

// Empty, ".", null or undefined mean the root. Paths are root-relative so they feed straight back into
// other routes, and a file path answers with that file, like `ls`.
export async function listEntries(
  rootDir: string,
  pathValue: unknown,
  options: ListEntriesOptions = {},
): Promise<Listing> {
  const relPath = requireDirPath(pathValue);
  const hostPath = await resolveHostPath(rootDir, relPath);
  // stat, not lstat: escaping symlinks are already refused, and a contained one lists like a read follows it.
  const stat = await fileSystemCall(relPath || "The root", () => fs.stat(hostPath));
  // A path naming a file is one entry, so there is nothing a ceiling could cut.
  const { nodes, truncated } = stat.isDirectory()
    ? await buildTree(hostPath, {
        maxDepth: options.maxDepth,
        maxEntries: options.maxEntries,
        basePath: relPath,
        countFiles: options.countFiles,
      })
    : { nodes: [{ name: path.posix.basename(relPath), type: "file" as const, path: relPath }], truncated: false };
  // After the cut, so measuring costs a read per entry the caller will actually be shown rather than
  // per entry the directory happens to hold.
  if (options.measure) await measure(rootDir, nodes, openFileLimiter());
  return { tree: nodes, truncated };
}

// A separate pass so the file panel's shared walk never pays for it, under the same fd budget. An
// unreadable file stays unmeasured rather than failing the listing.
async function measure(rootDir: string, nodes: TreeNode[], sem: Semaphore): Promise<void> {
  await Promise.all(
    nodes.map(async (node) => {
      if (node.type === "directory") return measure(rootDir, node.children ?? [], sem);
      try {
        const hostPath = await resolveHostPath(rootDir, node.path);
        // Sized before it is read, and never reported: the size is only ever the reason this stops.
        const { size } = await sem.run(() => fs.stat(hostPath));
        if (size > MAX_MEASURED_BYTES) return;
        // Count lines via the content operation, so the count matches what the read route would slice.
        const file = await sem.run(() => readFileEntry(rootDir, node.path));
        if (file.type === "text") node.lines = countLines(file.content);
      } catch {
        // Unmeasured: the entry keeps its name, which is what a listing is for.
      }
    }),
  );
}
