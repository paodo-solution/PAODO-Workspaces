// Drive collection: GET lists, POST creates. HTTP translation only; rules in lib/operations/drives/manage.ts.
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/lib/infra/logger";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createDrive, listDrives } from "@/lib/operations/drives/manage";

export function GET() {
  return NextResponse.json(listDrives());
}

export async function POST(req: NextRequest) {
  const log = createLogger("api").child({ route: "drives" });
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;

  try {
    return NextResponse.json(createDrive(parsed), { status: 201 });
  } catch (err) {
    // A rejected name is the user's to fix and arrives as an AppError, answered above without a log
    // line. Everything past it is mkdir/atomicSaveJson failing — a system fault an operator can act on.
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      { event: "drive_create_failed", outcome: "drive_not_created", err, name: parsed.name },
      "failed to create drive",
    );
    return errorResponse("INTERNAL_ERROR", "failed to create drive", { request: req });
  }
}
