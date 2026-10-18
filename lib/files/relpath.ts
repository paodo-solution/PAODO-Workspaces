// The file API's only path space: POSIX, relative to the workspace or drive root (spelled ""), so host paths
// stay private. Lexical only; symlink escapes are caught by ./containment.ts, which also runs on every request.

import path from "path";

// The container's mount point, named so an agent sending /workspace/... is told the right form rather
// than a bare "invalid path".
export const CONTAINER_MOUNT = "/workspace";

/** A path a caller is not allowed to say. Lexical only — see resolveContained for the disk half. */
export class InvalidPathError extends Error {
  constructor(
    readonly attemptedPath: string,
    reason: string,
  ) {
    super(reason);
    this.name = "InvalidPathError";
  }
}

function reject(attemptedPath: string, reason: string): never {
  throw new InvalidPathError(attemptedPath, reason);
}

// "" for the root, else a relative POSIX path with no "."/".." or trailing slash, usable as an identity
// key.
function normalizeClientPath(clientPath: string): string {
  const trimmed = clientPath.trim();

  // fs rejects these with ERR_INVALID_ARG_VALUE, which carries no errno and would surface as a 500.
  if (trimmed.includes("\0")) reject(clientPath, "A path cannot contain a null byte");

  if (trimmed === CONTAINER_MOUNT || trimmed.startsWith(`${CONTAINER_MOUNT}/`)) {
    const suggestion = trimmed.slice(CONTAINER_MOUNT.length + 1) || ".";
    reject(
      clientPath,
      `Paths are relative to the root — drop the "${CONTAINER_MOUNT}/" prefix and use "${suggestion}"`,
    );
  }
  if (trimmed.startsWith("/")) {
    reject(clientPath, "Paths must be relative to the root, not absolute");
  }

  // normalize leaves a leading ".." (refused below) and a trailing slash, stripped so "src/" and "src"
  // are one key (and "./" reaches the root check as ".").
  const normalized = path.posix.normalize(trimmed).replace(/\/$/, "");
  if (normalized === "" || normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    reject(clientPath, "Path escapes the root");
  }
  return normalized;
}

// A path that must name an entry inside the space. The root is refused: every caller of this reads,
// writes or deletes one thing, and "" reaching fs.rm would take the whole workspace or drive with it.
export function relativeEntryPath(clientPath: string): string {
  const relPath = normalizeClientPath(clientPath);
  if (relPath === "") reject(clientPath, "Path names the root, not an entry inside it");
  return relPath;
}

/** A directory path, where the root is a legitimate answer. `null`/`undefined`/"."/"" all mean root. */
export function relativeDirPath(clientPath: string | null | undefined): string {
  if (clientPath === null || clientPath === undefined) return "";
  return normalizeClientPath(clientPath);
}

/** Host path under `rootDir` to wire path ("" for the root), for the tree and the watcher. */
export function toRelativePath(rootDir: string, absPath: string): string {
  const relative = path.relative(rootDir, absPath);
  return relative === "" ? "" : relative.split(path.sep).join("/");
}
