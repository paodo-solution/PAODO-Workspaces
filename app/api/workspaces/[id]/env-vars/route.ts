// Workspace third-party secrets: GET lists metadata, POST stores one and returns its metadata (never the value).
import { type NextRequest, NextResponse } from "next/server";
import { notFound, requireWorkspace } from "@/lib/api/guards";
import { appErrorResponse, errorResponse, readJsonObject } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";
import { listWorkspaceSecrets } from "@/lib/operations/workspace/secrets";
import { updateWorkspace } from "@/lib/operations/workspace/update";

const log = createLogger("api").child({ route: "env-vars" });
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  // Same shape as the workspace-details route; no-store, since which secrets exist is still sensitive.
  return NextResponse.json(listWorkspaceSecrets(id), { headers: NO_STORE });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;

  const parsed = await readJsonObject(req);
  if (parsed instanceof Response) return parsed;
  const body = parsed as { name?: string; value?: string; domains?: string[] };

  try {
    // Missing fields are forwarded as empty rather than rejected here: the shared validator owns the
    // name, value and domain rules, so this route cannot state a narrower version of them.
    const result = await updateWorkspace(id, {
      secret: { name: body.name ?? "", value: body.value ?? "", domains: body.domains ?? [] },
    });
    if (!result) return notFound(req, `workspace ${id}`);
    return NextResponse.json(result.values.secret, { headers: NO_STORE });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      {
        event: "workspace_secret_store_failed",
        outcome: "secret_not_stored",
        code: "INTERNAL_ERROR",
        err,
        workspaceId: id,
      },
      "failed to store the secret",
    );
    return errorResponse("INTERNAL_ERROR", "failed to store the secret", { request: req });
  }
}
