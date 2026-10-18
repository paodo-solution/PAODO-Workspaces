// SSE plumbing for the chat and public agent routes. A keepalive comment frame (ignored by every client) stops
// proxies dropping silent streams (~100s on Cloudflare) while a tool call runs for up to 30 min.

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

/** Comfortably under the ~100s idle window proxies allow, without adding meaningful traffic. */
export const SSE_KEEPALIVE_MS = 15_000;

const KEEPALIVE_FRAME = ": ping\n\n";

/**
 * Emit a comment frame every SSE_KEEPALIVE_MS so the connection survives silent stretches.
 * Returns the stop function; callers must invoke it before closing the stream.
 */
export function startKeepalive(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  intervalMs: number = SSE_KEEPALIVE_MS,
): () => void {
  const timer = setInterval(() => {
    try {
      controller.enqueue(encoder.encode(KEEPALIVE_FRAME));
    } catch {
      /* stream already closed — nothing to keep alive */
    }
  }, intervalMs);
  // A finished run must not keep a Node process alive merely because its keepalive remains.
  timer.unref?.();
  return () => clearInterval(timer);
}
