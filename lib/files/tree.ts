// File-tree walker for workspace and drive routes, skipping what ./ignore.ts excludes. The default depth
// cap bounds the panel's response; other callers pass their own `?depth=` (one level, or Infinity).
import { createLogger } from "@/lib/infra/logger";
import { readListingEntries, readTransferEntries } from "./entries";
import { Fanout, MAX_CONCURRENT_WALKS, openFileLimiter, type Semaphore } from "./fdLimit";
import { withDir, type RootedDir } from "./rootedFs";

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
  /** The directory to walk, relative to `rootDir` (default "", the root itself). */
  startPath?: string;
  // The wire path nodes are prefixed with (default ""), so a subdirectory's paths match a whole-workspace
  // listing and work with the other file routes.
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

// Throws if `startPath` is missing, not a directory, or reached through a link; below it, an unreadable
// directory is an empty branch.
export async function buildTree(rootDir: string, options: BuildTreeOptions = {}): Promise<BuiltTree> {
  const maxDepth = options.maxDepth ?? FILE_PANEL_MAX_DEPTH;
  const walked = await withDir(rootDir, options.startPath ?? "", (dir) =>
    walk(
      dir,
      options.basePath ?? "",
      0,
      maxDepth,
      options.maxEntries ?? Infinity,
      { sem: openFileLimiter(), fanout: new Fanout(MAX_CONCURRENT_WALKS) },
      options.countFiles === true,
    ),
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

const EMPTY_WALK: WalkResult = { nodes: [], files: 0, cut: false, truncated: false };

// An unreadable directory renders as an empty branch rather than failing the panel: the tree is
// navigation, and one bad directory should not blank the whole file list.
async function descend<T>(dir: RootedDir, name: string, empty: T, fn: (child: RootedDir) => Promise<T>): Promise<T> {
  let child: RootedDir;
  try {
    child = await dir.openDir(name);
  } catch (err) {
    createLogger("api").warn({ err, relPath: dir.childRel(name) }, "failed to open directory in file tree");
    return empty;
  }
  try {
    return await fn(child);
  } finally {
    await child.close();
  }
}

interface WalkLimits {
  sem: Semaphore;
  fanout: Fanout;
}

// Subdirectories are walked through `fanout`, so the descriptors held stay bounded. Counts come back up
// the recursion, since below `maxDepth` there are no nodes to sum.
async function walk(
  dir: RootedDir,
  relPath: string,
  depth: number,
  maxDepth: number,
  maxEntries: number,
  limits: WalkLimits,
  countFiles: boolean,
): Promise<WalkResult> {
  // Past the caller's depth, the tree stops but the count must not: this is exactly the directory whose
  // size a caller cannot see, since it is being handed an empty branch.
  if (depth >= maxDepth) {
    return { ...EMPTY_WALK, files: countFiles ? await countFilesUnder(dir, limits) : 0 };
  }
  let read;
  try {
    read = await readListingEntries(dir, limits.sem, maxEntries);
  } catch (err) {
    createLogger("api").warn({ err, relPath: dir.relPath }, "failed to read directory in file tree");
    return EMPTY_WALK;
  }

  const relOf = (name: string) => (relPath === "" ? name : `${relPath}/${name}`);
  // Nothing below the last level is needed unless counting, so those directories are not even opened.
  const dirs = depth + 1 >= maxDepth && !countFiles ? [] : read.entries.filter((e) => e.isDirectory());
  const walked = await limits.fanout.map(dirs, (e) =>
    descend(dir, e.name, EMPTY_WALK, (child) =>
      walk(child, relOf(e.name), depth + 1, maxDepth, maxEntries, limits, countFiles),
    ),
  );
  const below = new Map(dirs.map((e, i) => [e.name, walked[i]]));

  const entryResults: { node: TreeNode; files: number; truncated: boolean }[] = [];
  for (const e of read.entries) {
    const entryRelPath = relOf(e.name);
    if (!e.isDirectory()) {
      entryResults.push({ node: { name: e.name, type: "file", path: entryRelPath }, files: 1, truncated: false });
      continue;
    }
    const sub = below.get(e.name) ?? EMPTY_WALK;
    entryResults.push({
      node: {
        name: e.name,
        type: "directory",
        path: entryRelPath,
        children: sub.nodes,
        ...(countFiles ? { files: sub.files } : {}),
        // `cut`, not `truncated`: the flag names the directory whose own listing stopped, so a
        // caller can find it. An ancestor that was listed whole is not a short answer.
        ...(sub.cut ? { truncated: true } : {}),
      },
      files: sub.files,
      truncated: sub.truncated,
    });
  }

  return {
    nodes: entryResults.map((r) => r.node),
    files: entryResults.reduce((sum, r) => sum + r.files, 0),
    cut: read.truncated,
    truncated: read.truncated || entryResults.some((r) => r.truncated),
  };
}

// Counts files below `maxDepth` without building nodes, through the same ignore rules as the listing.
// An unreadable directory counts as zero.
async function countFilesUnder(dir: RootedDir, limits: WalkLimits): Promise<number> {
  let entries;
  try {
    entries = await readTransferEntries(dir, limits.sem);
  } catch (err) {
    createLogger("api").warn({ err, relPath: dir.relPath }, "failed to read directory while counting a file tree");
    return 0;
  }

  const dirs = entries.filter((e) => e.isDirectory());
  const counts = await limits.fanout.map(dirs, (e) =>
    descend(dir, e.name, 0, (child) => countFilesUnder(child, limits)),
  );
  return entries.length - dirs.length + counts.reduce((sum, count) => sum + count, 0);
}
