// REST endpoint for a single workspace.
// GET returns its metadata; DELETE removes it from the registry and deletes its directory from disk.
import { type NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/lib/infra/logger";
import { notFound, workspaceIdParam } from "@/lib/api/guards";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { publicBaseUrl } from "@/lib/api/credentialRoutes";
import { receiptResponse } from "@/lib/api/workspaceUpdateReceipt";
import { getWorkspaceOverview } from "@/lib/operations/workspace/overview";
import { updateWorkspace, WORKSPACE_UPDATABLE_FIELDS as UPDATABLE_FIELDS } from "@/lib/operations/workspace/update";
import { deleteWorkspace } from "@/lib/operations/workspace/delete";
import { workspaceDeleteDeps } from "@/lib/infra/workspaceDeleteDeps";

const log = createLogger("api").child({ route: "workspace" });

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const param = workspaceIdParam((await params).id, req);
  if (param instanceof NextResponse) return param;
  const id = param;
  try {
    const connectionOrigin = publicBaseUrl() ?? new URL(req.url).origin;
    const workspace = await getWorkspaceOverview(id, connectionOrigin);
    if (!workspace) return notFound(req, `workspace ${id}`);
    return NextResponse.json(workspace, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "workspace_read_failed",
        outcome: "workspace_not_returned",
        code: "INTERNAL_ERROR",
        err,
        workspaceId: id,
      },
      "failed to read workspace",
    );
    return errorResponse("INTERNAL_ERROR", "failed to read workspace", { request: req });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const param = workspaceIdParam((await params).id, req);
  if (param instanceof NextResponse) return param;
  const id = param;
  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;
  const body = parsed as {
    name?: string;
    maxIterations?: number;
    maxRunMinutes?: number;
    llmProvider?: string;
    llmModel?: string;
    reasoningEffort?: string;
    description?: string;
    internetAccess?: boolean;
    domainRestriction?: boolean;
    allowedDomains?: string[];
    addAllowedDomains?: string[];
    removeAllowedDomains?: string[];
    workspaceApiAccess?: boolean;
    workspaceMcpAccess?: boolean;
  };

  // Field types are only claimed here; validateMetadata checks each one, so every trigger gets the same rejection.

  // Refused before any write, without echoing or logging the value, so the caller learns the field is real.
  if ("secret" in parsed) {
    return errorResponse(
      "WORKSPACE_SECRET_FORBIDDEN",
      `secrets cannot be set through this endpoint — POST /api/workspaces/${id}/env-vars stores one, GET lists them, DELETE /api/workspaces/${id}/env-vars/{name} removes one`,
      { request: req, details: { field: "secret", endpoint: `/api/workspaces/${id}/env-vars` } },
    );
  }

  // Unknown fields are rejected, not ignored, so a typo can't half-apply and report success. Errors list the
  // accepted fields.
  const unknown = Object.keys(body).filter((key) => !(UPDATABLE_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    return errorResponse(
      "INVALID_REQUEST",
      `unknown field(s): ${unknown.join(", ")} — accepted: ${UPDATABLE_FIELDS.join(", ")}`,
      { request: req, details: { fields: unknown, acceptedFields: [...UPDATABLE_FIELDS] } },
    );
  }
  const hasModel = body.llmProvider !== undefined || body.llmModel !== undefined || body.reasoningEffort !== undefined;
  const supplied = UPDATABLE_FIELDS.filter((field) => body[field] !== undefined);
  if (supplied.length === 0) {
    return errorResponse(
      "INVALID_REQUEST",
      `no fields supplied — send at least one of: ${UPDATABLE_FIELDS.join(", ")}`,
      { request: req, details: { acceptedFields: [...UPDATABLE_FIELDS] } },
    );
  }

  try {
    const result = await updateWorkspace(id, {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.maxIterations !== undefined ? { maxIterations: body.maxIterations } : {}),
      ...(body.maxRunMinutes !== undefined ? { maxRunMinutes: body.maxRunMinutes } : {}),
      ...(body.internetAccess !== undefined ? { internetAccess: body.internetAccess } : {}),
      ...(body.domainRestriction !== undefined ? { domainRestriction: body.domainRestriction } : {}),
      ...(body.allowedDomains !== undefined ? { allowedDomains: body.allowedDomains } : {}),
      ...(body.addAllowedDomains !== undefined ? { addAllowedDomains: body.addAllowedDomains } : {}),
      ...(body.removeAllowedDomains !== undefined ? { removeAllowedDomains: body.removeAllowedDomains } : {}),
      ...(body.workspaceApiAccess !== undefined ? { workspaceApiAccess: body.workspaceApiAccess } : {}),
      ...(body.workspaceMcpAccess !== undefined ? { workspaceMcpAccess: body.workspaceMcpAccess } : {}),
      // Omitted fields are forwarded as omitted, not as "": the operation resolves each missing one
      // from the workspace's current choice, so any subset of the three is a complete request.
      ...(hasModel
        ? {
            model: {
              ...(body.llmProvider !== undefined ? { provider: body.llmProvider } : {}),
              ...(body.llmModel !== undefined ? { model: body.llmModel } : {}),
              ...(body.reasoningEffort !== undefined ? { reasoningEffort: body.reasoningEffort } : {}),
            },
          }
        : {}),
    });
    if (!result) return notFound(req, `workspace ${id}`);
    // A mutation returns only its receipt. GET is the sole workspace representation, so adding a
    // projection there (skills, secrets, access state) can never make PATCH partial or expensive.
    return receiptResponse(result);
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "workspace_update_failed",
        outcome: "workspace_not_updated",
        code: "INTERNAL_ERROR",
        err,
        workspaceId: id,
      },
      "failed to update workspace",
    );
    return errorResponse("INTERNAL_ERROR", "failed to update workspace", { request: req });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const param = workspaceIdParam((await params).id, req);
  if (param instanceof NextResponse) return param;
  const id = param;
  try {
    const result = await deleteWorkspace(id, workspaceDeleteDeps());
    if (!result) return notFound(req, `workspace ${id}`);
    // `ok` alongside `deleted`, so this receipt branches like every other mutation's.
    return NextResponse.json({ ok: true, ...result });
  } catch {
    // The deletion operation logs the exact failed cleanup stage once; do not duplicate the private
    // exception here. This boundary only converts it to the safe public contract.
    return errorResponse("INTERNAL_ERROR", "failed to delete workspace", { request: req });
  }
}
