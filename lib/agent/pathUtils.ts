// Lexical path normalization for agent file tools. The tools that touch the volume host-side go through
// lib/files/rootedFs.ts, which never follows a link; the rest run inside the container.

import path from "path";

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
