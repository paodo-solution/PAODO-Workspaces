// Browser chat endpoint, one SSE response: a non-empty `message` starts a run, an empty one re-attaches.
// The run broker owns the run, so closing the tab only detaches.
import type { NextRequest } from "next/server";
import type { AgentEvent } from "@/lib/agent/runner";
import * as broker from "@/lib/agent/runBroker";
import { SSE_HEADERS, startKeepalive } from "@/lib/agent/sse";
import { createLogger } from "@/lib/infra/logger";
import { appErrorResponse } from "@/lib/api/errorResponse";
import { ConversationNotFoundError } from "@/lib/operations/agent/errors";
import { prepareWorkspaceChat } from "@/lib/operations/conversations/manage";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const log = createLogger("api").child({ workspaceId: id, route: "chat" });
  const body = (await req.json()) as { message?: string; conversationId?: string };
  let prepared;
  try {
    prepared = prepareWorkspaceChat(id, body);
  } catch (err) {
    if (err instanceof ConversationNotFoundError) return appErrorResponse(err, req)!;
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    throw err;
  }
  if (!prepared) return new Response("Workspace not found", { status: 404 });
  if (prepared.started === false) return new Response("A run is already in progress", { status: 409 });
  const { conversationId } = prepared;

  log.debug({ conversationId, mode: prepared.started === null ? "attach" : "send" }, "chat stream started");
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      // Keepalive through long silent tool calls, or the proxy drops the connection (lib/agent/sse.ts).
      const stopKeepalive = startKeepalive(controller, encoder);
      const send = (event: AgentEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        stopKeepalive();
        sub?.unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // Live events arrive here; 'done' ends the stream for this viewer.
      const sub = broker.subscribe(id, conversationId, (event) => {
        send(event);
        if (event.type === "done") close();
      });

      if (!sub) {
        // The run finished (or never existed) between the client's load and this attach. Nothing to
        // stream — the client already holds the persisted history.
        send({ type: "done" });
        close();
        return;
      }

      // Catch a late subscriber up, then live events flow via the callback above.
      for (const event of sub.replay) send(event);
      if (sub.status === "done") close();

      // Tab closed / navigated away: detach this viewer only. The run continues.
      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
