// Internet access and its domain allowlist: GET state, PATCH applies any of them via the shared update path.
// Wire name `enabled`; the receipt says `internetAccess`, like every other trigger.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { notFound, requireWorkspace } from "@/lib/api/guards";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { receiptResponse } from "@/lib/api/workspaceUpdateReceipt";
import { createLogger } from "@/lib/infra/logger";
import { updateWorkspace } from "@/lib/operations/workspace/update";

const log = createLogger("api").child({ route: "internet-access" });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  return NextResponse.json({
    enabled: ws.internetAccess,
    domainRestriction: ws.domainAllowlist?.restricted ?? false,
    allowedDomains: ws.domainAllowlist?.domains ?? [],
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;

  const body = await readJsonObject(req);
  if (body instanceof Response) return body;

  if (body.enabled === undefined && body.domainRestriction === undefined && body.allowedDomains === undefined) {
    return errorResponse("INVALID_REQUEST", "send at least one of: enabled, domainRestriction, allowedDomains", {
      request: req,
    });
  }

  try {
    // Values pass through unchecked: updateWorkspace validates each, so this route refuses like a workspace PATCH.
    const result = await updateWorkspace(id, {
      ...(body.enabled !== undefined ? { internetAccess: body.enabled as boolean } : {}),
      ...(body.domainRestriction !== undefined ? { domainRestriction: body.domainRestriction as boolean } : {}),
      ...(body.allowedDomains !== undefined ? { allowedDomains: body.allowedDomains as string[] } : {}),
    });
    // Past the guard above, a missing workspace means it was deleted mid-request.
    if (!result) return notFound(req, `workspace ${id}`);
    return receiptResponse(result);
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "internet_access_update_failed",
        outcome: "internet_access_not_changed",
        code: "INTERNAL_ERROR",
        err,
        workspaceId: id,
      },
      "failed to update internet access",
    );
    return errorResponse("INTERNAL_ERROR", "failed to update internet access", { request: req });
  }
}
