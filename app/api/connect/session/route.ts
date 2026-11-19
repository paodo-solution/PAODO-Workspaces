// The calling VS Code device: GET confirms the sign-in still works, DELETE signs it out.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api/errorResponse";
import { deviceIdFromRequest } from "@/lib/api/deviceAuth";
import { revokeDevice } from "@/lib/infra/security/credentialStore";

const NO_STORE = { "Cache-Control": "no-store" } as const;

export function GET(request: Request) {
  if (!deviceIdFromRequest(request)) return errorResponse("UNAUTHORIZED", "Sign in again", { request });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}

export function DELETE(request: Request) {
  const id = deviceIdFromRequest(request);
  if (!id) return errorResponse("UNAUTHORIZED", "Sign in again", { request });
  revokeDevice(id, "signed_out");
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
