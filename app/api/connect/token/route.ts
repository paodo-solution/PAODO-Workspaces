// VS Code's token endpoint, on the API host: a one-time code or a refresh token in, device tokens out.
// Exempt from the gate's credential check, since the body is the credential, so it is rate limited here.
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { rateLimited } from "@/lib/api/guards";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";
import { exchangeToken } from "@/lib/operations/connect/vscode";

const log = createLogger("api").child({ route: "connect/token" });

export async function POST(request: NextRequest) {
  const limited = rateLimited(request, { policy: "connectToken", logContext: { route: "connect/token" } });
  if (limited) return limited;
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  try {
    return NextResponse.json(exchangeToken(body), { headers: { "Cache-Control": "no-store", Pragma: "no-cache" } });
  } catch (err) {
    const expected = appErrorResponse(err, request);
    if (expected) return expected;
    log.error({ event: "connect_token_failed", outcome: "token_not_issued", err }, "connect token exchange failed");
    return errorResponse("INTERNAL_ERROR", "Could not issue a token", { request });
  }
}
