// The calling VS Code device follows the app live: one SSE stream of "something changed" signals, after a
// `ready` that carries what is running. The device is checked again every keepalive, so a lost sign-in ends it.
export const runtime = "nodejs";

import { errorResponse } from "@/lib/api/errorResponse";
import { deviceIdFromRequest } from "@/lib/api/deviceAuth";
import { runningConversations } from "@/lib/agent/runBroker";
import { SSE_HEADERS, SSE_KEEPALIVE_MS } from "@/lib/agent/sse";
import { listenerCount, subscribe, type AppEvent } from "@/lib/infra/realtime/eventHub";
import { MAX_EVENT_STREAMS } from "@/lib/infra/limits";

const encoder = new TextEncoder();
const frame = (data: object) => encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
const PING = encoder.encode(": ping\n\n");
/** Unread bytes a client may fall behind by (hundreds of events) before it is let go. */
const QUEUE_BYTES = 64 * 1024;

export function GET(request: Request) {
  if (!deviceIdFromRequest(request)) return errorResponse("UNAUTHORIZED", "Sign in again", { request });
  if (listenerCount() >= MAX_EVENT_STREAMS) {
    return errorResponse("SERVICE_UNAVAILABLE", "Too many live connections; try again shortly", { request });
  }

  let close = () => {};
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        // A client that stops reading is let go rather than queued for: it reconnects and reloads.
        const send = (chunk: Uint8Array) => {
          if (closed) return;
          if ((controller.desiredSize ?? 1) <= 0) return close();
          controller.enqueue(chunk);
        };
        const unsubscribe = subscribe((event: AppEvent) => send(frame(event)));
        const timer = setInterval(() => (deviceIdFromRequest(request) ? send(PING) : close()), SSE_KEEPALIVE_MS);
        timer.unref?.();
        close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        };
        send(frame({ type: "ready", running: runningConversations() }));
        request.signal.addEventListener("abort", close);
      },
      cancel: () => close(),
    },
    new ByteLengthQueuingStrategy({ highWaterMark: QUEUE_BYTES }),
  );
  return new Response(stream, { headers: SSE_HEADERS });
}
