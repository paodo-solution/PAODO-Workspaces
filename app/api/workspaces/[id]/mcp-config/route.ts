// MCP settings backend (separate from the /mcp protocol endpoint): GET state and exposed skills, PATCH toggle,
// POST generate/rotate, DELETE revoke. No write verb for skills: the agent authors them.
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { credentialHandlers, publicBaseUrl } from "@/lib/api/credentialRoutes";
import { getCredentialState } from "@/lib/operations/credentials/manage";
import { listWorkspaceSkills } from "@/lib/operations/workspace/skills";
import { requireWorkspaceId } from "@/lib/api/guards";
import { channelSetEnabled, workspaceReceiptContext } from "@/lib/api/workspaceUpdateReceipt";

type Params = { id: string };

const handlers = credentialHandlers<Params>(
  "workspace-mcp",
  async ({ id }, request) => {
    const ws = requireWorkspaceId(id, request);
    return ws instanceof NextResponse ? ws : ws.id;
  },
  {
    keyField: "workspaceMcpKey",
    setEnabled: channelSetEnabled("workspaceMcpAccess"),
    // Same vocabulary as the workspace projection, for the same reason as the API-key route.
    axisFields: { access: "workspaceMcpAccess", hasKey: "workspaceMcpHasKey" },
    receiptContext: workspaceReceiptContext,
  },
);

export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
export const PATCH = handlers.PATCH;

export async function GET(req: NextRequest, { params }: { params: Promise<Params> }) {
  const { id } = await params;
  const ws = requireWorkspaceId(id, req);
  if (ws instanceof NextResponse) return ws;

  const exposedSkills = await listWorkspaceSkills(ws.id);
  return NextResponse.json(
    {
      ...getCredentialState("workspace-mcp", ws.id),
      exposedSkills,
      publicBaseUrl: publicBaseUrl(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
