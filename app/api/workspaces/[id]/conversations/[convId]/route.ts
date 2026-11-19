// A conversation's saved transcript; if `running`, the client appends `userInput` and re-attaches.
// `?detail=tools` (VS Code) adds each tool call's arguments and output, and the files' snapshot.
import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { appErrorResponse } from "@/lib/api/errorResponse";
import { ConversationNotFoundError } from "@/lib/operations/agent/errors";
import { getWorkspaceConversation } from "@/lib/operations/conversations/manage";
import { currentSnapshot } from "@/lib/operations/conversations/snapshot";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id, convId } = await params;
  try {
    const toolDetail = req.nextUrl.searchParams.get("detail") === "tools";
    const result = getWorkspaceConversation(id, convId, {}, { toolDetail });
    if (!result) return notFound(req, `workspace ${id}`);
    return Response.json(toolDetail ? { ...result, snapshot: await currentSnapshot(id) } : result);
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      return appErrorResponse(err, req) ?? new Response("Conversation not found", { status: 404 });
    }
    throw err;
  }
}
