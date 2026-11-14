// One-file upload handler for workspace and drive routes. Streams to a temp file beside the destination
// (rootedFs), renamed into place only when complete; folders are N requests to keep memory flat.
import { type NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import path from "path";
import { createLogger } from "@/lib/infra/logger";
import { MAX_UPLOAD_BYTES, formatBytes } from "@/lib/uploads/limits";
import { checkFreeSpace, RESERVED_FREE_BYTES } from "@/lib/infra/storage/diskSpace";
import { createPendingFile, type PendingFile } from "@/lib/files/rootedFs";
import { requireEntryPath } from "@/lib/operations/files/paths";
import { fileSystemAppError } from "@/lib/operations/files/errors";
import { AppError } from "@/lib/errors/appError";
import { errorResponse } from "@/lib/api/errorResponse";

export interface UploadBackend {
  dir: string;
  logContext: Record<string, unknown>;
  // Called after a successful upload (workspace git snapshot) with the written file's name. The
  // backend owns the commit message, because only it knows whether this file is one of a burst.
  afterWrite?: (fileName: string) => Promise<void>;
}

/** Thrown by the counting stage below when a body runs past the limit mid-transfer. */
class PayloadTooLargeError extends Error {
  constructor(readonly receivedBytes: number) {
    super("payload too large");
  }
}

export async function handleUpload(req: NextRequest, be: UploadBackend): Promise<Response> {
  const log = createLogger("api");
  const limitLabel = formatBytes(MAX_UPLOAD_BYTES);

  // One helper builds the log record and the response, so they can't disagree. `rejectedAt` separates the
  // up-front Content-Length refusal from the mid-stream one.
  const tooLarge = (filePath: string, actualBytes: number, rejectedAt: "content_length" | "stream") => {
    log.warn(
      {
        ...be.logContext,
        event: "upload_payload_too_large",
        outcome: "upload_rejected",
        filePath,
        actualBytes,
        limitBytes: MAX_UPLOAD_BYTES,
        rejectedAt,
      },
      // Static message with the sizes in fields, so the line stays greppable and aggregatable; the
      // human-readable rendering belongs in the response the user actually reads.
      "upload rejected — payload exceeds the per-file upload limit",
    );
    return errorResponse(
      "FILE_TOO_LARGE",
      `File is ${formatBytes(actualBytes)}, which is over the ${limitLabel} per-file upload limit.`,
      { request: req, details: { field: "path", limitBytes: MAX_UPLOAD_BYTES } },
    );
  };

  // Distinct from tooLarge: the file may be within limits but the host is out of room (our problem, not the user's).
  const insufficientStorage = (filePath: string, neededBytes: number, freeBytes: number) => {
    log.error(
      {
        ...be.logContext,
        event: "upload_insufficient_storage",
        outcome: "upload_rejected",
        filePath,
        neededBytes,
        freeBytes,
      },
      "upload rejected — not enough free disk space",
    );
    return errorResponse("STORAGE_EXHAUSTED", "Not enough free disk space to accept this upload.", {
      request: req,
    });
  };

  // requireEntryPath keeps `?path=` a relative entry path; rootedFs refuses any link on the way to it.
  const { searchParams } = new URL(req.url);
  let filePath: string;
  try {
    filePath = requireEntryPath(searchParams.get("path"));
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return errorResponse(err.code, err.message, { request: req, details: err.details });
  }

  // Refuse on the declared size before reading a byte, so a doomed body is never spooled to disk.
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return tooLarge(filePath, declared, "content_length");
  }

  // Chunked bodies declare no length, so assume the worst case (the per-file cap) rather than
  // skip the check — same conservative stance the size limit above takes.
  const neededBytes = Number.isFinite(declared) && declared > 0 ? declared : MAX_UPLOAD_BYTES;
  const space = await checkFreeSpace(be.dir, neededBytes, RESERVED_FREE_BYTES);
  if (!space.ok) return insufficientStorage(filePath, neededBytes, space.freeBytes);

  // Written beside its destination, in a directory reached without following a link, and renamed into
  // place only when complete.
  let pending: PendingFile;
  try {
    pending = await createPendingFile(be.dir, filePath);
  } catch (err) {
    const known = fileSystemAppError(err, filePath);
    if (!known) throw err;
    return errorResponse(known.code, known.message, { request: req, details: known.details });
  }

  try {
    await pipeline(
      // Cast: NextRequest.body is a web ReadableStream, which Readable.fromWeb accepts but does not
      // share a nominal type with. A bodyless POST still writes a legitimate empty file.
      req.body ? Readable.fromWeb(req.body as Parameters<typeof Readable.fromWeb>[0]) : Readable.from([]),
      async function* count(source) {
        let received = 0;
        for await (const chunk of source) {
          received += (chunk as Buffer).length;
          // Content-Length is absent on chunked bodies and can simply lie, so this is the check
          // that actually holds the limit.
          if (received > MAX_UPLOAD_BYTES) throw new PayloadTooLargeError(received);
          yield chunk;
        }
      },
      // The stream closes the handle when it finishes; pipeline would otherwise wait for a close forever.
      pending.handle.createWriteStream(),
    );
    await pending.commit();
  } catch (err) {
    await pending.discard();
    if (err instanceof PayloadTooLargeError) return tooLarge(filePath, err.receivedBytes, "stream");
    log.error(
      {
        ...be.logContext,
        event: "uploaded_file_write_failed",
        outcome: "file_not_written",
        err,
        filePath,
      },
      "failed to write uploaded file",
    );
    // Logged either way, but a recognised errno keeps its own code, so a full disk isn't reported as a bug.
    const known = fileSystemAppError(err, filePath);
    return known
      ? errorResponse(known.code, known.message, { request: req, details: known.details })
      : errorResponse("INTERNAL_ERROR", "The upload could not be written", { request: req });
  }

  await be.afterWrite?.(path.posix.basename(filePath));
  return NextResponse.json({ ok: true });
}
