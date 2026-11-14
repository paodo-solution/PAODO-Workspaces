// Maps filesystem errnos to public error codes, with messages built from the caller's relative path (libuv's
// would leak the host path). An unknown errno is not guessed as a 4xx: the caller logs it and answers 500.

import { AppError, type AppErrorCode } from "@/lib/errors/appError";

interface Classification {
  code: AppErrorCode;
  /** Built from the relative path the caller named — never from err.message. */
  message: (relPath: string) => string;
}

// Only errnos a real call path reaches; this vocabulary is never redefined, so don't pad it. Anything
// unmapped becomes a logged 500.
const BY_ERRNO: Record<string, Classification> = {
  // read, stat and unlink of something that is not there.
  ENOENT: { code: "NOT_FOUND", message: (p) => `${p} does not exist` },
  // readFile of a directory.
  EISDIR: { code: "INVALID_REQUEST", message: (p) => `${p} is a directory, not a file` },
  // A path that runs *through* a file, e.g. "notes.txt/inner".
  ENOTDIR: { code: "INVALID_REQUEST", message: (p) => `${p} is not a directory` },

  // rootedFs refusals: a symbolic link anywhere on the path, or a FIFO, socket or device at its end.
  ELOOP: { code: "INVALID_REQUEST", message: (p) => `${p} is a symbolic link; the app does not follow links` },
  ENOTREG: { code: "INVALID_REQUEST", message: (p) => `${p} is not a regular file` },
  // rootedFs's depth cap, or a name the filesystem itself finds too long.
  ENAMETOOLONG: { code: "INVALID_REQUEST", message: (p) => `${p} is too long or too deeply nested` },

  // Retrying cannot help until someone changes the permissions, so this is not a 400 asking the client
  // to fix its request.
  EACCES: { code: "FILE_NOT_WRITABLE", message: (p) => `${p} is not writable` },
  EPERM: { code: "FILE_NOT_WRITABLE", message: (p) => `${p} is not writable` },

  // A write or an upload that ran the volume out mid-stream.
  ENOSPC: { code: "STORAGE_EXHAUSTED", message: () => "Not enough free disk space" },
};

/** Whether the operation reads or writes, which decides how a permission failure is named. */
export type FileAccess = "read" | "write";

const NOT_READABLE: Classification = { code: "FILE_NOT_READABLE", message: (p) => `${p} is not readable` };

// Null for an errno with no public meaning: the caller logs it and answers 500. Messages use `relPath`,
// never the host path.
export function fileSystemAppError(err: unknown, relPath: string, access: FileAccess = "write"): AppError | null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code !== "string") return null;
  const denied = code === "EACCES" || code === "EPERM";
  const classification = denied && access === "read" ? NOT_READABLE : BY_ERRNO[code];
  if (!classification) return null;
  return new AppError(classification.code, classification.message(relPath), { field: "path" });
}

// Run a filesystem operation, translating any errno it raises. Use this rather than a bare fs call so
// a new operation cannot accidentally reintroduce the raw-errno-out-the-door behaviour.
export async function fileSystemCall<T>(
  relPath: string,
  run: () => Promise<T>,
  access: FileAccess = "write",
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw fileSystemAppError(err, relPath, access) ?? err;
  }
}
