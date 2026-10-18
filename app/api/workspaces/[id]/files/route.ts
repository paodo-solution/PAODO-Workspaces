// The workspace file tree, for the file panel and the CLI. Query contract: lib/api/fileTreeRoutes.ts.
import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { getFileTree } from "@/lib/api/fileTreeRoutes";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return getFileTree(req, { dir: ws.dir, logContext: { workspaceId: id, route: "workspace-files" } });
}
