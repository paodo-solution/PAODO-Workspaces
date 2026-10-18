// File-tree walker for workspace and drive routes, skipping what ./ignore.ts excludes. The default depth
// cap bounds the panel's response; other callers pass their own `?depth=` (one level, or Infinity).
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { readListingEntries, readTransferEntries } from "./entries";
import { openFileLimiter, type Semaphore } from "./fdLimit";

export interface TreeNode {
  name: string;
  type: "file" | "directory";
  /** Workspace-relative, POSIX-separated — the one path space the file API speaks (./relpath.ts). */
  path: string;
  children?: TreeNode[];
  /** Line count for a text file, so a caller can pick `?offset=`/`?limit=`. Only when measuring. */
  lines?: number;
  // Files at any depth, after the ignore rules, so it shows whether a directory is worth descending.
  // Directories aren't counted; only present when counting.
  files?: number;
  // Set only on a directory cut at `maxEntries`: `children` is then an arbitrary prefix in filesystem
  // order. Omitted otherwise, since an always-false flag gets ignored.
  truncated?: boolean;
}

/** What the file panel renders in one response. */
export const FILE_PANEL_MAX_DEPTH = 5;

export interface BuildTreeOptions {
  /** Levels to descend before stopping. Infinity walks the whole tree. */
  maxDepth?: number;
  // Per-directory entry cap, bounding breadth as `maxDepth` bounds depth. Defaults to Infinity so the
  // file panel is never silently shortened.
  maxEntries?: number;
  // The wire path of `rootDir` (default ""), so a subdirectory's paths match a whole-workspace listing
  // and work with the other file routes.
  basePath?: string;
  // Adds a recursive `files` count per directory. Opt-in: a shallow listing must walk the whole subtree
  // to compute it.
  countFiles?: boolean;
}

/** A finished tree, and whether any directory in it was cut short by the entry ceiling. */
export interface BuiltTree {
  nodes: TreeNode[];
  // Some directory hit `maxEntries`. Aggregated here since the root has no node to carry the flag, and
  // a caller shouldn't have to search for it.
  truncated: boolean;
}

export async function buildTree(rootDir: string, options: BuildTreeOptions = {}): Promise<BuiltTree> {
  const maxDepth = options.maxDepth ?? FILE_PANEL_MAX_DEPTH;
  const walked = await walk(
    rootDir,
    options.basePath ?? "",
    0,
    maxDepth,
    options.maxEntries ?? Infinity,
    openFileLimiter(),
    options.countFiles === true,
  );
  return { nodes: walked.nodes, truncated: walked.truncated };
}

/** The nodes of one directory, and — when counting — every file underneath it, however deep. */
interface WalkResult {
  nodes: TreeNode[];
  files: number;
  /** This directory's own listing stopped at the ceiling. What the node's flag is built from. */
  cut: boolean;
  /** This directory or anything below it stopped. The aggregate, and only BuiltTree carries it. */
  truncated: boolean;
}

// `relPath` is built from descended segments, which is safe even on a symlinked root. Counts come back
// up the recursion, since below `maxDepth` there are no nodes to sum.
async function walk(
  dirPath: string,
  relPath: string,
  depth: number,
  maxDepth: number,
  maxEntries: number,
  sem: Semaphore,
  countFiles: boolean,
): Promise<WalkResult> {
  // Past the caller's depth, the tree stops but the count must not: this is exactly the directory whose
  // size a caller cannot see, since it is being handed an empty branch.
  if (depth >= maxDepth) {
    return { nodes: [], files: countFiles ? await countFilesUnder(dirPath, sem) : 0, cut: false, truncated: false };
  }
  let read;
  try {
    read = await readListingEntries(dirPath, sem, maxEntries);
  } catch (err) {
    // An unreadable directory renders as an empty branch rather than failing the panel: the tree is
    // navigation, and one bad directory should not blank the whole file list.
    createLogger("api").warn({ err, dirPath }, "failed to read directory in file tree");
    return { nodes: [], files: 0, cut: false, truncated: false };
  }

  const entryResults = await Promise.all(
    read.entries.map(async (e): Promise<{ node: TreeNode; files: number; truncated: boolean }> => {
      const hostPath = path.join(dirPath, e.name);
      const entryRelPath = relPath === "" ? e.name : `${relPath}/${e.name}`;
      if (e.isDirectory()) {
        const below = await walk(hostPath, entryRelPath, depth + 1, maxDepth, maxEntries, sem, countFiles);
        return {
          node: {
            name: e.name,
            type: "directory",
            path: entryRelPath,
            children: below.nodes,
            ...(countFiles ? { files: below.files } : {}),
            // `cut`, not `truncated`: the flag names the directory whose own listing stopped, so a
            // caller can find it. An ancestor that was listed whole is not a short answer.
            ...(below.cut ? { truncated: true } : {}),
          },
          files: below.files,
          truncated: below.truncated,
        };
      }
      return { node: { name: e.name, type: "file", path: entryRelPath }, files: 1, truncated: false };
    }),
  );

  return {
    // Promise.all preserves input order regardless of resolution order, so entries keep readdir's order.
    nodes: entryResults.map((r) => r.node),
    files: entryResults.reduce((sum, r) => sum + r.files, 0),
    cut: read.truncated,
    truncated: read.truncated || entryResults.some((r) => r.truncated),
  };
}

// Counts files below `maxDepth` without building nodes, through the same ignore rules as the listing.
// An unreadable directory counts as zero.
async function countFilesUnder(dirPath: string, sem: Semaphore): Promise<number> {
  let entries;
  try {
    entries = await readTransferEntries(dirPath, sem);
  } catch (err) {
    createLogger("api").warn({ err, dirPath }, "failed to read directory while counting a file tree");
    return 0;
  }

  const counts = await Promise.all(
    entries.map((e) => (e.isDirectory() ? countFilesUnder(path.join(dirPath, e.name), sem) : Promise.resolve(1))),
  );
  return counts.reduce((sum, count) => sum + count, 0);
}
