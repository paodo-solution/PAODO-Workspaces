// Lists one directory of a workspace or drive (walk in lib/files/tree.ts). Resolves the caller's path and maps
// errnos, so a bad path is an error rather than an empty tree.

import fs from "fs/promises";
import path from "path";
import { buildTree, type TreeNode } from "@/lib/files/tree";
import { openFileLimiter, type Semaphore } from "@/lib/files/fdLimit";
import { countLines, readFileEntry } from "./content";
import { fileSystemCall } from "./errors";
import { requireDirPath, resolveHostPath } from "./paths";

/**
 * The largest file a listing will read in order to count its lines.
 *
 * There has to be a bound, because measuring is the one thing a listing does whose cost is the size of
 * the workspace rather than the shape of it, and `?depth=full` over a directory holding a multi-gigabyte
 * log would otherwise read it to answer a question about names. Past this the entry carries no `lines`,
 * the same as a file that has none to count.
 */
const MAX_MEASURED_BYTES = 4 * 1024 * 1024;

export interface ListEntriesOptions {
  /** Levels to descend, counted from the directory listed. Infinity walks all of it. */
  maxDepth?: number;
  /**
   * Add `lines` to every file that is text and under MAX_MEASURED_BYTES.
   *
   * Off by default, and the file panel never asks for it: a line count can only be had by reading the
   * file, so measuring turns a listing of N names into N reads. It exists for the caller that reads
   * files one window at a time — `paodo <workspace|drive> file cat --offset --limit` — which otherwise has to discover
   * how long a file is by running off the end of it.
   */
  measure?: boolean;
  /**
   * Add `files` to every directory: everything underneath it, however deep.
   *
   * Off by default and paid for only when asked, like `measure` above — a one-level listing has to walk
   * the whole subtree to answer, so the cost of an `ls` stops being the shape of the directory listed and
   * becomes the size of the tree below it. It exists for a caller deciding where to go next rather than
   * rendering what it already has: a directory of three entries holding fourteen thousand files is worth
   * knowing about before descending, and the tree alone cannot say so.
   */
  countFiles?: boolean;
  /**
   * The most entries any one directory may contribute. Absent means no ceiling, which is what the file
   * panel wants and what every caller got before there was one.
   *
   * Breadth is the half of a listing `maxDepth` does not bound: one level of a directory holding a
   * million files is a bounded depth and an unbounded answer, and on a drive that answer is built
   * host-side with no container limit above it. A caller that navigates passes a ceiling and reads
   * `truncated` to know it was reached.
   */
  maxEntries?: number;
}

/** A listing, and whether the ceiling cut any part of it short. */
export interface Listing {
  tree: TreeNode[];
  truncated: boolean;
}

/**
 * The entries under `pathValue`, which names a directory inside the space — `null`, `undefined`,
 * "" and "." all meaning the root, so a caller that wants everything passes nothing.
 *
 * Two things a caller depends on:
 *
 *   - Every node's `path` is named from the root, not from the directory listed, so a path
 *     this returns can be handed straight back to the content, transfer and delete routes.
 *   - A path naming a file answers with that one file rather than failing, the way `ls` of a file
 *     does. The caller asked what is at that path, and "a file" and "nothing" are different answers.
 *     It is also what the sibling transfer route already does with the same parameter (./transfer.ts).
 */
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

/**
 * Annotates every file in `nodes` in place with what it costs to read.
 *
 * A second pass over the finished tree rather than a branch inside the walk, because the walk is shared
 * with the file panel, which must never pay for this — and because the pass is over nodes already in
 * memory, so the only cost it adds is the reads it was asked to make. Through the same descriptor
 * budget the walk used, so a wide directory cannot open a file handle per entry at once.
 *
 * A file that cannot be read is left unmeasured rather than failing the listing, for the reason the
 * walker already logs and continues on: this is navigation, and one unreadable file should not turn a
 * question about names into an error.
 */
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
