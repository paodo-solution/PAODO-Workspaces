// CLI token settings, UI-admin only: kept out of platformAccessPolicy.ts so the CLI token can't reach the
// route that mints it. Same credential handlers as the API-key and MCP endpoints (enable and create are separate).
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { credentialHandlers, publicBaseUrl } from "@/lib/api/credentialRoutes";
import { getCredentialState } from "@/lib/operations/credentials/manage";

const handlers = credentialHandlers<Record<string, never>>("platform", async () => null);

export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
export const PATCH = handlers.PATCH;

export function GET() {
  return NextResponse.json(
    { ...getCredentialState("platform"), publicBaseUrl: publicBaseUrl() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
