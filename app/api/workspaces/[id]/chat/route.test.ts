// The chat stream of a VS Code device ends once its sign-in is lost; the run itself is left going.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({ lost: false }));
const unsubscribe = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/deviceAuth", () => ({ deviceSignInLost: () => device.lost }));
vi.mock("@/lib/operations/conversations/manage", () => ({
  prepareWorkspaceChat: () => ({ conversationId: "c1", started: null }),
}));
vi.mock("@/lib/agent/runBroker", () => ({
  subscribe: () => ({ replay: [], status: "running", unsubscribe }),
}));

import { NextRequest } from "next/server";
import { SSE_KEEPALIVE_MS } from "@/lib/agent/sse";
import { POST } from "./route";

const decoder = new TextDecoder();
const params = Promise.resolve({ id: "w1" });
const request = () =>
  new NextRequest("http://localhost/api/workspaces/w1/chat", {
    method: "POST",
    headers: { authorization: "Bearer dat_x" },
    body: JSON.stringify({ conversationId: "c1" }),
  });

async function next(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string | null> {
  const { value, done } = await reader.read();
  return done ? null : decoder.decode(value);
}

beforeEach(() => {
  device.lost = false;
  unsubscribe.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("POST /api/workspaces/{id}/chat", () => {
  it("keeps streaming while the device is signed in", async () => {
    const reader = (await POST(request(), { params })).body!.getReader();
    vi.advanceTimersByTime(SSE_KEEPALIVE_MS);
    expect(await next(reader)).toBe(": ping\n\n");
    expect(unsubscribe).not.toHaveBeenCalled();
    await reader.cancel();
  });

  it("detaches once the device's sign-in is lost", async () => {
    const reader = (await POST(request(), { params })).body!.getReader();
    device.lost = true;
    vi.advanceTimersByTime(SSE_KEEPALIVE_MS);
    let chunk = await next(reader);
    while (chunk !== null) chunk = await next(reader);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
