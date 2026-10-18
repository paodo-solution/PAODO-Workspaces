// HTTP transport for the file-tree endpoint, shared by workspace and drive routes so both answer the same
// query; rules live in lib/operations/files/listing.ts. Paths are root-relative (lib/files/relpath.ts).
import { NextResponse } from "next/server";
import { createLogger } from "@/lib/infra/logger";
import { appErrorResponse, errorResponse } from "@/lib/api/errorResponse";
import { AppError } from "@/lib/errors/appError";
import type { FileBackend } from "@/lib/files/backend";
import { MAX_DRIVE_LISTING_ENTRIES } from "@/lib/infra/limits";
import { listEntries } from "@/lib/operations/files/listing";

/**
 * `?depth=`, in levels below the directory listed: a positive integer for that many, "full" for all of
 * them, absent for the file panel's own rendering budget (lib/files/tree.ts). An unreadable depth is
 * refused, not defaulted: answering with a different tree than asked would be silently wrong.
 */
function requestedDepth(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (value === "full") return Infinity;
  const levels = Number(value);
  if (!Number.isInteger(levels) || levels < 1) {
    throw new AppError("INVALID_REQUEST", `depth must be a positive integer or "full", got "${value}"`, {
      field: "depth",
    });
  }
  return levels;
}

/**
 * `?limit=`, the most entries any one directory may contribute: a positive integer, "max", or absent for no
 * ceiling at all — which is what the file panel asks for, and what every caller got before this
 * existed.
 *
 * Refused rather than rounded, for the reason `?depth=` is: a listing is what a caller decides what to
 * read or delete from next, and quietly answering with a different set than the one asked for leaves
 * nothing in the response to say so.
 */
function requestedLimit(value: string | null): number | undefined {
  if (value === null) return undefined;
  // The app's own ceiling, for a caller that wants a bounded listing without restating the bound.
  if (value === "max") return MAX_DRIVE_LISTING_ENTRIES;
  const entries = Number(value);
  if (!Number.isInteger(entries) || entries < 1) {
    throw new AppError("INVALID_REQUEST", `limit must be a positive integer or "max", got "${value}"`, {
      field: "limit",
    });
  }
  return entries;
}

export async function getFileTree(request: Request, be: FileBackend): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const log = createLogger("api").child(be.logContext);
  // Absent means the root; a named directory gets that subtree, still with root-relative paths.
  const source = searchParams.get("path");

  try {
    const depth = requestedDepth(searchParams.get("depth"));
    // `?measure=1` (file sizes and line counts) and `?count=1` (files under each directory) are opt-in:
    // each costs a read or a walk per entry, for numbers the file panel does not render.
    const limit = requestedLimit(searchParams.get("limit"));
    const { tree, truncated } = await listEntries(be.dir, source, {
      ...(depth === undefined ? {} : { maxDepth: depth }),
      ...(limit === undefined ? {} : { maxEntries: limit }),
      ...(searchParams.get("measure") === "1" ? { measure: true } : {}),
      ...(searchParams.get("count") === "1" ? { countFiles: true } : {}),
    });
    // `truncated` only when it is true, so the key is present exactly when it means something, with the
    // `limit` beside it so a reader is told the ceiling it hit.
    return NextResponse.json({ tree, ...(truncated ? { truncated: true, limit } : {}) });
  } catch (err) {
    const known = appErrorResponse(err, request);
    if (known) return known;
    log.error({ event: "file_tree_failed", outcome: "tree_not_returned", err, source }, "failed to list files");
    return errorResponse("INTERNAL_ERROR", "The files could not be listed", { request });
  }
}
