// An expired IAP session must send the user back to login instead of failing a call silently.
import { describe, it, expect, vi } from "vitest";

import { installSessionGuard } from "./sessionGuard";

const ORIGIN = "https://ui.example.com";

function fakeWindow(response: () => Response) {
  const original = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response());
  const reload = vi.fn();
  const win = { fetch: original as unknown as typeof fetch, location: { href: `${ORIGIN}/`, origin: ORIGIN, reload } };
  installSessionGuard(win);
  return { win, original, reload };
}

// Response.type is read-only and always "default" when constructed, so fake the manual-redirect shape.
const opaqueRedirect = () => Object.defineProperty(new Response(null), "type", { value: "opaqueredirect" });

describe("installSessionGuard", () => {
  it("reloads once when a same-origin call hits the IAP redirect", async () => {
    const { win, original, reload } = fakeWindow(opaqueRedirect);
    await win.fetch("/api/workspaces/x", { method: "DELETE" });
    await win.fetch("/api/workspaces");
    expect(original.mock.calls[0][1]).toMatchObject({ method: "DELETE", redirect: "manual" });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads on a 401 from the app's auth gate", async () => {
    const { win, reload } = fakeWindow(() => new Response(null, { status: 401 }));
    await win.fetch(`${ORIGIN}/api/workspaces`);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("leaves ordinary failures to the caller", async () => {
    const { win, reload } = fakeWindow(() => new Response(null, { status: 500 }));
    const res = await win.fetch("/api/workspaces");
    expect(res.status).toBe(500);
    expect(reload).not.toHaveBeenCalled();
  });

  it("does not touch cross-origin requests", async () => {
    const { win, original, reload } = fakeWindow(() => new Response(null, { status: 401 }));
    await win.fetch("https://other.example.com/x");
    expect(original.mock.calls[0][1]).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
  });

  it("wraps only once when installed twice", async () => {
    const { win, original } = fakeWindow(() => new Response(null));
    installSessionGuard(win);
    await win.fetch("/api/workspaces");
    expect(original).toHaveBeenCalledTimes(1);
  });
});
