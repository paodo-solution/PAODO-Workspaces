// Validates a caller path lexically (relpath.ts) into the wire-space relative path, the same for UI, CLI
// and agent. Reaching the disk is lib/files/rootedFs.ts, which never follows a link.

import { AppError, requireNonEmptyString } from "@/lib/errors/appError";
import { InvalidPathError, relativeDirPath, relativeEntryPath } from "@/lib/files/relpath";

/** `details.field` names which input was wrong, so a client can point at the right argument. */
function invalidPath(error: unknown, field: string): AppError {
  if (error instanceof InvalidPathError) {
    return new AppError("INVALID_REQUEST", error.message, { field });
  }
  throw error;
}

/** Validate a required path naming one entry. Returns the wire-space relative path. */
export function requireEntryPath(value: unknown, field = "path"): string {
  const raw = requireNonEmptyString(value, field);
  try {
    return relativeEntryPath(raw);
  } catch (err) {
    throw invalidPath(err, field);
  }
}

/** Validate an optional directory path. `null`/`undefined` mean the root, and so does "" or ".". */
export function requireDirPath(value: unknown, field = "path"): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") {
    throw new AppError("INVALID_REQUEST", `${field} must be a string`, { field });
  }
  try {
    return relativeDirPath(value);
  } catch (err) {
    throw invalidPath(err, field);
  }
}
