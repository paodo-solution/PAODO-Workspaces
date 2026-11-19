// The connect page's Authorize button: UI login only (in no token's route list), same-origin by the gate's
// CSRF check. Returns the loopback URL that hands the one-time code to VS Code.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { deviceApiUrl } from "@/lib/api/deviceAuth";
import { createLogger } from "@/lib/infra/logger";
import { authorizeConnect } from "@/lib/operations/connect/vscode";

const log = createLogger("api").child({ route: "connect/authorize" });

export async function POST(request: Request) {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  try {
    return NextResponse.json(authorizeConnect(body, deviceApiUrl(request.headers)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err) {
    const expected = appErrorResponse(err, request);
    if (expected) return expected;
    log.error({ event: "connect_authorize_failed", outcome: "code_not_issued", err }, "connect authorize failed");
    return errorResponse("INTERNAL_ERROR", "Could not authorize VS Code", { request });
  }
}
