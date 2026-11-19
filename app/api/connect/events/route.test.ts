// The device's live stream: refused without a valid device, `ready` first, events forwarded, ended once the device is not.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({ id: "d1" as string | null }));
vi.mock("@/lib/api/deviceAuth", () => ({ deviceIdFromRequest: () => device.id }));
vi.mock("@/lib/agent/runBroker", () => ({
  runningConversations: () => [{ workspaceId: "w1", conversationId: "c1" }],
}));

import { SSE_KEEPALIVE_MS } from "@/lib/agent/sse";
import { MAX_EVENT_STREAMS_PER_DEVICE } from "@/lib/infra/limits";
import { listenerCount, publish } from "@/lib/infra/realtime/eventHub";
import { GET } from "./route";

const decoder = new TextDecoder();
const request = () =>
  new Request("http://localhost/api/connect/events", { headers: { authorization: "Bearer dat_x" } });

async function next(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string | null> {
  const { value, done } = await reader.read();
  return done ? null : decoder.decode(value);
}

beforeEach(() => {
  device.id = "d1";
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/connect/events", () => {
  it("refuses a request without a valid device token", async () => {
    device.id = null;
    expect(GET(request()).status).toBe(401);
    expect(listenerCount()).toBe(0);
  });

  it("starts with what is running, then forwards each change", async () => {
    const response = GET(request());
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    expect(await next(reader)).toBe(
      `data: ${JSON.stringify({ type: "ready", running: [{ workspaceId: "w1", conversationId: "c1" }] })}\n\n`,
    );

    publish({ type: "conversations_changed", workspaceId: "w1" });
    expect(await next(reader)).toBe(
      `data: ${JSON.stringify({ type: "conversations_changed", workspaceId: "w1" })}\n\n`,
    );

    await reader.cancel();
    expect(listenerCount()).toBe(0);
  });

  it("caps one device's open streams, without blocking another device, and frees a slot on close", async () => {
    const readers = Array.from({ length: MAX_EVENT_STREAMS_PER_DEVICE }, () => GET(request()).body!.getReader());
    expect(GET(request()).status).toBe(429);

    device.id = "d2";
    const other = GET(request());
    expect(other.status).toBe(200);
    await other.body!.cancel();

    device.id = "d1";
    await readers[0].cancel();
    const response = GET(request());
    expect(response.status).toBe(200);
    const again = response.body!.getReader();
    for (const reader of [...readers.slice(1), again]) await reader.cancel();
    expect(listenerCount()).toBe(0);
  });

  it("pings while the device is valid, and ends the stream once it is not", async () => {
    vi.useFakeTimers();
    const reader = GET(request()).body!.getReader();
    await next(reader);

    vi.advanceTimersByTime(SSE_KEEPALIVE_MS);
    expect(await next(reader)).toBe(": ping\n\n");

    device.id = null;
    vi.advanceTimersByTime(SSE_KEEPALIVE_MS);
    expect(await next(reader)).toBeNull();
    expect(listenerCount()).toBe(0);
  });
});
