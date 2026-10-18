// A conversation's saved transcript. If `running`, the in-flight run isn't in it yet: the client appends
// `userInput` and re-attaches to the live stream.
import type { NextRequest } from "next/server";
import { notFound } from "@/lib/api/guards";
import { appErrorResponse } from "@/lib/api/errorResponse";
import { ConversationNotFoundError } from "@/lib/operations/agent/errors";
import { getWorkspaceConversation } from "@/lib/operations/conversations/manage";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string; convId: string }> }) {
  const { id, convId } = await params;
  try {
    const result = getWorkspaceConversation(id, convId);
    if (!result) return notFound(_req, `workspace ${id}`);
    return Response.json(result);
  } catch (err) {
    if (err instanceof ConversationNotFoundError) {
      return appErrorResponse(err, _req) ?? new Response("Conversation not found", { status: 404 });
    }
    throw err;
  }
}
