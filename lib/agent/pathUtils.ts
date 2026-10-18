// Path containment for agent file tools: a cheap lexical pre-check, then resolveWorkspacePath realpaths
// to catch symlinks. Host and container see the same volume, so a host-side check covers container writes.

import path from "path";
import { resolveContained } from "@/lib/files/containment";

// The container's name for the workspace root. The agent uses /workspace paths in shell commands, so file
// tools accept them too.
const CONTAINER_ROOT = "/workspace";

// Trims CONTAINER_ROOT off a normalized path ("" for the root itself), or null if it lies elsewhere.
// Normalization has already collapsed "..", and "/workspacefoo" fails the segment boundary.
function trimContainerRoot(normalized: string): string | null {
  if (normalized === CONTAINER_ROOT) return "";
  if (!normalized.startsWith(`${CONTAINER_ROOT}/`)) return null;
  return normalized.slice(CONTAINER_ROOT.length + 1).replace(/\/+$/, "");
}

export function normalizeRelpath(filePath: string): string | null {
  const normalized = path.posix.normalize(filePath);
  // "" means the caller named the workspace root, which is a directory, never a file.
  if (normalized.startsWith("/")) return trimContainerRoot(normalized) || null;
  return normalized.startsWith("..") ? null : normalized;
}

export function normalizeDirPath(dirPath: string | undefined): string | null {
  if (!dirPath || dirPath === ".") return ".";
  const normalized = path.posix.normalize(dirPath);
  if (normalized.startsWith("/")) {
    const trimmed = trimContainerRoot(normalized);
    return trimmed === null ? null : trimmed || ".";
  }
  return normalized.startsWith("..") ? null : normalized;
}

/**
 * Realpath-based containment check for a workspace path. `workspaceDir` is the host path for the
 * workspace (not the container's `/workspace` view, which `relpath` may itself be expressed in).
 * Returns null if `relpath` escapes — via `..`, an absolute path outside `/workspace`, or a symlink
 * anywhere along the way.
 */
export async function resolveWorkspacePath(workspaceDir: string, relpath: string): Promise<string | null> {
  const normalized = normalizeRelpath(relpath);
  if (normalized === null) return null;
  return resolveContained(workspaceDir, normalized);
}

/**
 * Normalize a caller-supplied file path and realpath-contain it in one step — the check every
 * write tool (file_write, file_edit) needs before touching disk. Returns the normalized,
 * workspace-relative path, or null if it escapes lexically or via a symlink.
 */
export async function containWorkspacePath(workspaceDir: string, filePath: string): Promise<string | null> {
  const relpath = normalizeRelpath(filePath);
  if (relpath === null) return null;
  return (await resolveWorkspacePath(workspaceDir, relpath)) === null ? null : relpath;
}
