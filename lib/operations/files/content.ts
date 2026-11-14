// Read, overwrite and remove file entries in a workspace or drive. HTTP-agnostic (plain values, AppError)
// so transfers and agent tools can reuse them; the HTTP side is lib/api/fileContentRoutes.ts.

import path from "path";
import { AppError } from "@/lib/errors/appError";
import { overwriteFile, readFile, withParent, type RootedDir } from "@/lib/files/rootedFs";
import { createLogger } from "@/lib/infra/logger";
import { fileSystemAppError, fileSystemCall } from "./errors";

/** Hooks a backend contributes. A drive supplies neither: it is passive host storage. */
export interface FileWriteHooks {
  // Overwrites via the container for legacy root-owned files the host can't write. Takes the wire-space
  // path, and must never create a missing one (see writeTextFile).
  writeFallback?: (relPath: string, content: Uint8Array) => Promise<void>;
  /** Git snapshot hook. Failure here must not invalidate a write that already reached disk. */
  afterWrite?: (message: string) => Promise<void>;
}

export type ClassifiedFile =
  | { type: "image"; mimeType: string; bytes: Buffer }
  | { type: "text"; content: string; bytes: Buffer }
  | { type: "binary"; bytes: Buffer };

// `image` is a format a browser paints. SVG is not: it executes script when navigated to, and this
// content is agent-written, so it stays text. rawMediaType enforces the same rule at the header.
async function classifyBuffer(bytes: Buffer): Promise<ClassifiedFile> {
  const { fileTypeFromBuffer } = await import("file-type");
  const result = await fileTypeFromBuffer(bytes);

  if (result) {
    if (result.mime.startsWith("image/")) return { type: "image", mimeType: result.mime, bytes };
    return { type: "binary", bytes };
  }

  try {
    return { type: "text", content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), bytes };
  } catch {
    return { type: "binary", bytes };
  }
}

// Read one file and classify it as text, image or binary. Always returns the bytes as well, since the
// file has been read either way and a raw-byte response would otherwise read it twice.
export async function readFileEntry(rootDir: string, relPath: string): Promise<ClassifiedFile> {
  const bytes = await fileSystemCall(relPath, () => readFile(rootDir, relPath));
  return classifyBuffer(bytes);
}

// 0-based `offset` and a line count, so `{ offset: 49, limit: 50 }` is editor lines 50–99. Same terms as
// the agent's fileRead tool, so API and agent callers can't mix them up.
export interface LineRange {
  offset: number;
  limit?: number;
}

/** Absent, or an integer no smaller than `min`. Absent is undefined only — see requireLineRange. */
function requireCount(value: unknown, field: string, min: number): number | undefined {
  if (value === null || value === undefined) return undefined;
  // An empty parameter is a caller that sent it and left it blank, which is not the same as omitting
  // it: Number("") is 0, and for `offset` that would silently mean "from the top of the file".
  const count = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : NaN;
  if (!Number.isInteger(count) || count < min) {
    throw new AppError("INVALID_REQUEST", `${field} must be a whole number of at least ${min}`, { field });
  }
  return count;
}

// The requested window, or null for the whole file when both are absent. Non-integers are refused, not
// rounded: `offset=abc` read as 0 would silently return the wrong lines.
export function requireLineRange(offset: unknown, limit: unknown): LineRange | null {
  const start = requireCount(offset, "offset", 0);
  const count = requireCount(limit, "limit", 1);
  if (start === undefined && count === undefined) return null;
  return { offset: start ?? 0, ...(count === undefined ? {} : { limit: count }) };
}

// Lines keep their own terminators, so a window to the end is byte-identical to the file's tail. Past
// the end is empty, not an error, like `sed -n`.
export function sliceLines(content: string, { offset, limit }: LineRange): string {
  if (content === "") return "";
  const terminated = content.endsWith("\n");
  const lines = content.split("\n");
  // The split's final "" is the terminator, not a line: without this, every window of a normal text
  // file would report one more line than the file has and an offset at the end would return "".
  if (terminated) lines.pop();

  const selected = lines.slice(offset, limit === undefined ? undefined : offset + limit);
  if (selected.length === 0) return "";
  const reachesEnd = offset + selected.length === lines.length;
  return selected.join("\n") + (reachesEnd && !terminated ? "" : "\n");
}

// Must match sliceLines' notion of a line: a trailing "\n" ends a line rather than starting one, so
// "a\n" and "a" are both one line, and an empty file has zero.
export function countLines(content: string): number {
  if (content === "") return 0;
  let lines = content.endsWith("\n") ? 0 : 1;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) lines += 1;
  return lines;
}

// Never creates (no O_CREAT), so a save racing a move fails instead of resurrecting the old path; an
// open that won the race follows the inode to its new name.
export async function writeTextFile(
  rootDir: string,
  relPath: string,
  content: string,
  hooks: FileWriteHooks = {},
): Promise<void> {
  try {
    await overwriteFile(rootDir, relPath, content);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if ((code === "EACCES" || code === "EPERM") && hooks.writeFallback) {
      await fileSystemCall(relPath, () => hooks.writeFallback!(relPath, Buffer.from(content, "utf-8")));
    } else if (code === "ENOENT") {
      // Deliberately not the classifier's NOT_FOUND: on a write, a path that is not there means the
      // save lost a race to a move, which the client resolves by reloading rather than by retrying.
      throw new AppError("CONFLICT", "File was moved or deleted before it could be saved", { field: "path" });
    } else {
      throw fileSystemAppError(err, relPath) ?? err;
    }
  }
  await hooks.afterWrite?.(`saved ${path.basename(relPath)}`);
}

// Paths a receipt lists before it only counts, so `rm node_modules` doesn't return a huge list.
// `removedCount` still gives the full total.
export const MAX_REPORTED_REMOVALS = 100;

export interface RemoveReceipt {
  // What was removed: the entry itself first, then everything that was under it, parents before their
  // children and siblings in name order. No longer than `maxReported`.
  removed: string[];
  /** Everything that was removed, including whatever the cap left out of `removed`. */
  removedCount: number;
  // Set only when the list was cut short ("100 of 1500 removed paths listed"), so a person reading it
  // can't mistake it for the whole answer.
  note?: string;
}

export interface RemoveOptions {
  /** How many paths the receipt names. Defaults to MAX_REPORTED_REMOVALS. */
  maxReported?: number;
}

// Unlike other walks, ignores nothing: `rm` takes node_modules too, and a receipt must never
// under-report. An unreadable dir lists only itself; the removal reports the real error.
async function collectRemovals(
  parent: RootedDir,
  name: string,
  relPath: string,
  isDirectory: boolean,
  maxReported: number,
  receipt: RemoveReceipt,
): Promise<void> {
  receipt.removedCount += 1;
  if (receipt.removed.length < maxReported) receipt.removed.push(relPath);
  if (!isDirectory) return;

  let dir: RootedDir;
  try {
    dir = await parent.openDir(name);
  } catch (err) {
    createLogger("api").warn({ err, relPath }, "failed to read directory while listing a removal");
    return;
  }
  try {
    const entries = await dir.entries();
    // isDirectory() is false for a symlink, so the walk stops at the link, exactly where the removal
    // stops too: a link is unlinked, never descended.
    for (const entry of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      await collectRemovals(dir, entry.name, `${relPath}/${entry.name}`, entry.isDirectory(), maxReported, receipt);
    }
  } catch (err) {
    createLogger("api").warn({ err, relPath }, "failed to read directory while listing a removal");
  } finally {
    await dir.close();
  }
}

// Paths are listed before removing, so a file created mid-delete goes unnamed. Accepted over locking,
// which a writer could starve; it's a receipt, not an audit.
export async function removeEntry(
  rootDir: string,
  relPath: string,
  hooks: FileWriteHooks = {},
  options: RemoveOptions = {},
): Promise<RemoveReceipt> {
  const parentRel = path.posix.dirname(relPath);
  const receipt: RemoveReceipt = { removed: [], removedCount: 0 };
  const maxReported = options.maxReported ?? MAX_REPORTED_REMOVALS;
  await fileSystemCall(relPath, () =>
    withParent(rootDir, relPath, async (parent, name) => {
      // Checked up front so an unwritable parent is reported as such, rather than as whichever errno a
      // recursive removal raises once part of it has already succeeded.
      await fileSystemCall(parentRel === "." ? "The root" : parentRel, () => parent.assertWritable());
      const stat = await parent.lstat(name);
      await collectRemovals(parent, name, relPath, stat.isDirectory(), maxReported, receipt);
      await parent.remove(name);
    }),
  );
  await hooks.afterWrite?.(`deleted ${path.basename(relPath)}`);
  if (receipt.removed.length < receipt.removedCount) {
    receipt.note = `${receipt.removed.length} of ${receipt.removedCount} removed paths listed`;
  }
  return receipt;
}
