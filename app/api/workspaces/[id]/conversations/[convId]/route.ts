// A conversation's saved transcript. If `running`, the in-flight run isn't in it yet: the client appends
// `userInput` and re-attaches. `?detail=tools` adds each tool call's arguments and output (VS Code's tool log).
import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { appErrorResponse } from "@/lib/api/errorResponse";
import { ConversationNotFoundError } from "@/lib/operations/agent/errors";
import { getWorkspaceConversation } from "@/lib/operations/conversations/manage";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id, convId } = await params;
  try {
    const toolDetail = req.nextUrl.searchParams.get("detail") === "tools";
    const result = getWorkspaceConversation(id, convId, {}, { toolDetail });
    if (!result) return notFound(req, `workspace ${id}`);
    return Response.json(result);
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      return appErrorResponse(err, req) ?? new Response("Conversation not found", { status: 404 });
    }
    throw err;
  }
}
