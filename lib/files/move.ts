// File move policy shared by workspace and drive routes: validation, contained no-clobber moves, batch
// outcomes and one snapshot. Paths are relative; `destinationDirectory: null` means the root.

import { NextResponse } from "next/server";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { AppError, publicErrorBody, type AppErrorCode, type ErrorDetails } from "@/lib/errors/appError";
import { errorResponse, readJsonObject, requestIdOf, statusForCode } from "@/lib/api/errorResponse";
import { fileSystemAppError } from "@/lib/operations/files/errors";
import { requireDirPath, requireEntryPath } from "@/lib/operations/files/paths";
import { createDir, linkEntry, removeEmptyDir, renameEntry, statEntry, unlinkEntry } from "./rootedFs";
import type { FileBackend } from "./backend";

interface MoveBody {
  /** Wire-space relative paths, already validated by the caller. */
  sourcePath: string;
  destinationDirectory: string;
}

// A code, not a status: a partly successful batch answers 200, so the reason lives in the body.
interface MoveFailure {
  code: AppErrorCode;
  error: string;
}

interface MoveOutcome {
  sourcePath: string;
  /** Lexical destination, in the path space the file tree serves. */
  path: string;
  unchanged: boolean;
  /** Internal fields used to compose the batch snapshot message. */
  name: string;
  destinationLabel: string;
}

function isFailure<T extends object>(result: T | MoveFailure): result is MoveFailure {
  return "error" in result;
}

interface MoveTarget {
  rootDir: string;
  /** Root-relative paths; every filesystem call resolves them without following a link. */
  source: string;
  destination: string;
  unchanged: boolean;
  destinationLabel: string;
  isDirectory: boolean;
}

class DestinationConflictError extends Error {}

async function resolveMoveTarget(be: FileBackend, body: MoveBody): Promise<MoveTarget | MoveFailure> {
  // lstat, so a link is seen as a link. The root cannot appear here: requireEntryPath refuses "".
  const sourceStat = await statEntry(be.dir, body.sourcePath);
  if (sourceStat.isSymbolicLink()) {
    return { code: "INVALID_REQUEST", error: "Symbolic links cannot be moved" };
  }

  if (!(await statEntry(be.dir, body.destinationDirectory)).isDirectory()) {
    return { code: "INVALID_REQUEST", error: "Destination must be a directory" };
  }

  // Wire paths are normalized and no link is followed, so comparing them is comparing the entries.
  if (
    sourceStat.isDirectory() &&
    (body.destinationDirectory === body.sourcePath || body.destinationDirectory.startsWith(`${body.sourcePath}/`))
  ) {
    return { code: "INVALID_REQUEST", error: "Cannot move a folder into itself" };
  }

  const name = path.posix.basename(body.sourcePath);
  const destination = body.destinationDirectory === "" ? name : `${body.destinationDirectory}/${name}`;
  return {
    rootDir: be.dir,
    source: body.sourcePath,
    destination,
    unchanged: destination === body.sourcePath,
    destinationLabel: body.destinationDirectory || "workspace root",
    isDirectory: sourceStat.isDirectory(),
  };
}

/** Move one item without ever replacing an existing destination. */
async function moveWithoutOverwrite(target: MoveTarget): Promise<void> {
  const { rootDir, source, destination } = target;
  if (!target.isDirectory) {
    try {
      await linkEntry(rootDir, source, destination);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        throw new DestinationConflictError();
      }
      throw err;
    }

    try {
      await unlinkEntry(rootDir, source);
    } catch (err) {
      // Both names reference the same inode, so this rollback cannot remove another writer's file.
      await unlinkEntry(rootDir, destination).catch(() => undefined);
      throw err;
    }
    return;
  }

  // Reserve the directory name so rename cannot silently replace an empty directory.
  try {
    await createDir(rootDir, destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new DestinationConflictError();
    }
    throw err;
  }

  try {
    await renameEntry(rootDir, source, destination);
  } catch (err) {
    // Only remove our still-empty reservation. A populated reservation is deliberately retained.
    await removeEmptyDir(rootDir, destination).catch(() => undefined);
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTEMPTY") throw new DestinationConflictError();
    throw err;
  }
}

async function moveOne(
  be: FileBackend,
  sourcePath: string,
  destinationDirectory: string,
  log: ReturnType<typeof createLogger>,
): Promise<MoveOutcome | MoveFailure> {
  try {
    const target = await resolveMoveTarget(be, { sourcePath, destinationDirectory });
    if (isFailure(target)) return target;

    const outcome: MoveOutcome = {
      sourcePath,
      path: target.destination,
      unchanged: target.unchanged,
      name: path.posix.basename(target.source),
      destinationLabel: target.destinationLabel,
    };
    if (target.unchanged) return outcome;

    try {
      await moveWithoutOverwrite(target);
    } catch (err) {
      if (err instanceof DestinationConflictError) {
        return {
          code: "CONFLICT",
          error: `An item named ${path.posix.basename(target.destination)} already exists in that folder`,
        };
      }

      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw err;
      return { code: "FILE_NOT_WRITABLE", error: "Source or destination directory is not writable" };
    }
    return outcome;
  } catch (err) {
    // AppErrors keep their code; anything else is logged once and reported as INTERNAL_ERROR, never libuv's
    // host-path message.
    const known = err instanceof AppError ? err : fileSystemAppError(err, sourcePath);
    if (known) return { code: known.code, error: known.message };
    log.error(
      { event: "file_move_failed", outcome: "item_not_moved", err, sourcePath, destinationDirectory },
      "unclassified file move failure",
    );
    return { code: "INTERNAL_ERROR", error: "The move failed" };
  }
}

// Not the plain error envelope: `results` is on every response, refusals included, so the client can
// reconcile its tree; its absence means the request wasn't understood.
interface MoveBatchBody {
  ok?: boolean;
  results: { sourcePath: string; path: string; unchanged: boolean }[];
  /** The error envelope's fields, present when something stopped the batch. */
  code?: AppErrorCode;
  error?: string;
  details?: ErrorDetails;
  requestId?: string;
  failedSourcePath?: string | null;
}

/** Refuse the batch, carrying the envelope's fields plus the empty result list its client expects. */
function refuseBatch(
  req: Request,
  failure: MoveFailure,
  extras: { details?: ErrorDetails; failedSourcePath?: string | null } = {},
): Response {
  const body: MoveBatchBody = {
    ...publicErrorBody(failure.code, failure.error, { details: extras.details, requestId: requestIdOf(req) }),
    results: [],
    ...(extras.failedSourcePath !== undefined ? { failedSourcePath: extras.failedSourcePath } : {}),
  };
  return NextResponse.json(body, { status: statusForCode(failure.code) });
}

/** Move one or more root items into one directory, stopping at the first failed item. */
export async function moveFileContent(req: Request, be: FileBackend): Promise<Response> {
  const candidate = await readJsonObject(req);
  if (candidate instanceof NextResponse) return candidate;

  const rawSourcePaths = candidate.sourcePaths;
  if (!Array.isArray(rawSourcePaths) || rawSourcePaths.length === 0) {
    return errorResponse("INVALID_REQUEST", "sourcePaths must be a non-empty array of paths", {
      request: req,
      details: { field: "sourcePaths" },
    });
  }

  // Every path is validated up front rather than per item, so a batch containing one unsayable path is
  // refused whole instead of moving the items before it and then stopping.
  let sourcePaths: string[];
  let destinationDirectory: string;
  try {
    sourcePaths = rawSourcePaths.map((p) => requireEntryPath(p, "sourcePaths"));
    // null is the client's way of naming the root, and stays so; "" is its wire-space equivalent.
    destinationDirectory = requireDirPath(candidate.destinationDirectory ?? null, "destinationDirectory");
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return refuseBatch(req, { code: err.code, error: err.message }, { details: err.details });
  }

  const log = createLogger("api").child(be.logContext);
  const results: MoveOutcome[] = [];
  let failure: MoveFailure | null = null;
  let failedSourcePath: string | null = null;

  for (const sourcePath of sourcePaths) {
    const result = await moveOne(be, sourcePath, destinationDirectory, log);
    if (isFailure(result)) {
      failure = result;
      failedSourcePath = sourcePath;
      break;
    }
    results.push(result);
  }

  const moved = results.filter((result) => !result.unchanged);
  if (moved.length > 0) {
    const message =
      moved.length === 1
        ? `moved ${moved[0].name} to ${moved[0].destinationLabel}`
        : `moved ${moved.length} items to ${moved[0].destinationLabel}`;
    try {
      await be.afterWrite?.(message);
    } catch (err) {
      // The disk move already succeeded, so a snapshot failure must not invalidate the response.
      log.warn({ err }, "move snapshot failed");
    }
  }

  // Nothing moved: plain failure. Partly moved: 200 with per-item results so the client can reconcile.
  if (failure && results.length === 0) return refuseBatch(req, failure, { failedSourcePath });

  const body: MoveBatchBody = {
    ok: failure === null,
    results: results.map(({ sourcePath, path: destination, unchanged }) => ({
      sourcePath,
      path: destination,
      unchanged,
    })),
    ...(failure ? { code: failure.code, error: failure.error, failedSourcePath } : {}),
  };
  return NextResponse.json(body);
}
