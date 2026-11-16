// "Allow VS Code connections" in Settings, UI-admin only (in no token's route list). Turning it off also
// signs out every VS Code.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { deviceAccessEnabled, setDeviceAccess } from "@/lib/infra/security/credentialStore";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function GET() {
  return NextResponse.json({ enabled: deviceAccessEnabled() }, { headers: NO_STORE });
}

export async function PATCH(request: Request) {
  const body = await readJsonObject(request);
  if (body instanceof Response) return body;
  if (typeof body.enabled !== "boolean") {
    return errorResponse("INVALID_REQUEST", "enabled must be true or false", {
      request,
      details: { field: "enabled" },
    });
  }
  setDeviceAccess(body.enabled);
  return NextResponse.json({ enabled: deviceAccessEnabled() }, { headers: NO_STORE });
}
