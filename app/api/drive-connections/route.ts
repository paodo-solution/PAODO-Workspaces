// Drive↔workspace connections: GET, POST, DELETE; separate from the agent-call graph. HTTP translation only;
// integrity rules in lib/operations/drives/connect.ts.
import { NextResponse, type NextRequest } from "next/server";
import { listConnections } from "@/lib/drives/store";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { connectDriveToWorkspace, disconnectDriveFromWorkspace } from "@/lib/operations/drives/connect";
import { createLogger } from "@/lib/infra/logger";

const log = createLogger("api").child({ route: "drive-connections" });

export function GET() {
  return NextResponse.json(listConnections());
}

export async function POST(req: NextRequest) {
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;

  try {
    return NextResponse.json(connectDriveToWorkspace(parsed), { status: 201 });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "drive_connect_failed",
        outcome: "drive_connection_not_persisted",
        code: "INTERNAL_ERROR",
        err,
      },
      "failed to connect drive",
    );
    return errorResponse("INTERNAL_ERROR", "failed to connect drive", { request: req });
  }
}

export async function DELETE(req: NextRequest) {
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;

  try {
    return NextResponse.json(disconnectDriveFromWorkspace(parsed));
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "drive_disconnect_failed",
        outcome: "drive_connection_not_removed",
        code: "INTERNAL_ERROR",
        err,
      },
      "failed to disconnect drive",
    );
    return errorResponse("INTERNAL_ERROR", "failed to disconnect drive", { request: req });
  }
}
