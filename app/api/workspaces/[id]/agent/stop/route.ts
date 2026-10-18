// Public stop for a run started via POST .../agent (Bearer key); the runner finishes its current turn so
// history stays valid.
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { guardWorkspaceApi } from "@/lib/api/workspaceApiAuth";
import { notFound } from "@/lib/api/guards";
import { stopWorkspaceConversation } from "@/lib/operations/conversations/manage";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const denied = guardWorkspaceApi(req, id, "agent-stop");
  if (denied) return denied;

  const body = (await req.json().catch(() => ({}))) as { conversationId?: string };
  if (!body.conversationId?.trim()) return new Response("conversationId is required", { status: 400 });

  const result = stopWorkspaceConversation(id, body.conversationId);
  if (!result) return notFound(req, `workspace ${id}`);
  return Response.json({ stopped: result.stopped, conversationId: result.conversationId });
}
