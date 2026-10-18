// The "workspace-api" kind keeps this endpoint from touching the MCP secret or CLI token. The channel's axes stay
// independent: PATCH moves only the flag and POST/DELETE only the key, so a key can predate or outlive an open channel.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspace: { id: "ws-1", name: "Alpha", dir: "/fake/alpha", internetAccess: false },
  state: { enabled: false, hasKey: false, createdAt: null as string | null, lastUsedAt: null as string | null },
  setEnabled: vi.fn(),
  mint: vi.fn(() => "pak_new"),
  revoke: vi.fn(),
  found: true,
}));

vi.mock("@/lib/api/guards", async () => {
  const { NextResponse } = await import("next/server");
  return {
    requireWorkspaceId: () => (h.found ? h.workspace : NextResponse.json({ error: "not found" }, { status: 404 })),
  };
});
vi.mock("@/lib/infra/security/credentialStore", () => ({
  state: () => h.state,
  setEnabled: h.setEnabled,
  mint: h.mint,
  revoke: h.revoke,
}));
vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({
    getWorkspace: (id: string) => (h.found && id === h.workspace.id ? h.workspace : undefined),
    listWorkspaces: () => [h.workspace],
  }),
}));

import { DELETE, GET, PATCH, POST } from "./route";

const ctx = (id = "ws-1") => ({ params: Promise.resolve({ id }) });
const request = (method: string, body?: string) =>
  new Request("http://x/api/workspaces/ws-1/api-key", {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body,
  }) as never;

beforeEach(() => {
  h.state = { enabled: false, hasKey: false, createdAt: null, lastUsedAt: null };
  h.found = true;
  h.setEnabled.mockClear();
  h.mint.mockClear();
  h.revoke.mockClear();
  // Mirrors the store: revoking clears the hash. DELETE's precondition and its receipt read the same
  // state, so a mock that never mutated would report a key still present and make a repeat look legal.
  h.revoke.mockImplementation(() => {
    h.state = { ...h.state, hasKey: false };
  });
});

describe("workspace API key route", () => {
  it("reports channel state without leaking the secret hash", async () => {
    h.state = { enabled: true, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const body = await (await GET(request("GET"), ctx())).json();
    expect(body).toMatchObject({ enabled: true, hasKey: true });
    expect(body).not.toHaveProperty("hash");
    expect(body).not.toHaveProperty("plain");
  });

  it("validates PATCH bodies, including malformed JSON", async () => {
    const malformed = await PATCH(request("PATCH", "not json"), ctx());
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    const invalid = await PATCH(request("PATCH", JSON.stringify({ enabled: "yes" })), ctx());
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });

  // Opening the channel must not mint a key, or a caller flipping the flag receives a read-once secret it
  // never asked for and may discard.
  it("opens the channel without minting a key", async () => {
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx());
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: { workspaceApiAccess: true },
    });
    expect(h.setEnabled).toHaveBeenCalledWith("workspace-api", "ws-1", true);
    expect(h.mint).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // Rotating on every toggle would invalidate a key that agents already hold.
  it("leaves an existing key alone when the channel is reopened", async () => {
    h.state = { enabled: false, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx());
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: { workspaceApiAccess: true },
    });
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("mints nothing when the channel is closed", async () => {
    const res = await PATCH(request("PATCH", JSON.stringify({ enabled: false })), ctx());
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: { workspaceApiAccess: false },
    });
    expect(h.setEnabled).toHaveBeenCalledWith("workspace-api", "ws-1", false);
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("generates the first key and rotates it afterwards", async () => {
    expect(await (await POST(request("POST", JSON.stringify({ operation: "generate" })), ctx())).json()).toEqual({
      ok: true,
      workspaceApiKey: "pak_new",
      workspaceApiAccess: false,
      workspaceApiHasKey: true,
      internetAccess: false,
    });

    h.state = { enabled: true, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    expect(await (await POST(request("POST", JSON.stringify({ operation: "rotate" })), ctx())).json()).toEqual({
      ok: true,
      workspaceApiKey: "pak_new",
      workspaceApiAccess: true,
      workspaceApiHasKey: true,
      internetAccess: false,
    });
    expect(h.mint).toHaveBeenCalledWith("workspace-api", "ws-1");
    expect(h.mint).toHaveBeenCalledTimes(2);
  });

  // Issuing first keeps the channel closed while the key is in transit, and revoking a leaked key must never
  // require reopening the channel it leaked from.
  it("issues and destroys a key while the channel is closed", async () => {
    h.state = { enabled: false, hasKey: false, createdAt: null, lastUsedAt: null };
    const generated = await POST(request("POST", JSON.stringify({ operation: "generate" })), ctx());
    expect(generated.status).toBe(200);
    // The receipt also says nothing accepts the key yet; otherwise an agent reading only the key field hands it on,
    // every call fails, and nothing points back at the closed channel.
    expect(await generated.json()).toEqual({
      ok: true,
      workspaceApiKey: "pak_new",
      workspaceApiAccess: false,
      workspaceApiHasKey: true,
      internetAccess: false,
    });

    h.state = { enabled: false, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };
    const rotated = await POST(request("POST", JSON.stringify({ operation: "rotate" })), ctx());
    expect(rotated.status).toBe(200);

    const revoked = await DELETE(request("DELETE"), ctx());
    expect(revoked.status).toBe(200);
    expect(h.revoke).toHaveBeenCalledWith("workspace-api", "ws-1");
    // Neither verb touched the access flag.
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  // Revocation refuses on the same condition as rotation: a revoke that destroys nothing must not answer 200, or
  // an operator clearing a leak cannot tell whether this request ended it.
  it("refuses revocation when there is no key to destroy", async () => {
    h.state = { enabled: true, hasKey: false, createdAt: null, lastUsedAt: null };

    const res = await DELETE(request("DELETE"), ctx());

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "CREDENTIAL_NOT_CONFIGURED",
      details: { credentialKind: "workspace-api", operation: "revoke" },
    });
    expect(h.revoke).not.toHaveBeenCalled();
  });

  // The accepted cost of that refusal: revocation is not idempotent, so a caller retrying after a dropped
  // response must read the channel back rather than expect a repeated 200.
  it("destroys the key once and refuses the repeat", async () => {
    h.state = { enabled: true, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };

    const first = await DELETE(request("DELETE"), ctx());
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ok: true,
      workspaceApiAccess: true,
      workspaceApiHasKey: false,
      internetAccess: false,
    });

    const second = await DELETE(request("DELETE"), ctx());
    expect(second.status).toBe(409);
    expect(h.revoke).toHaveBeenCalledTimes(1);
  });

  // Revoking the last key leaves the channel open and keyless, and the receipt says so in the workspace
  // projection's words (workspaceApiAccess), so `ok: true` alone is not mistaken for a closed channel.
  it("reports the open, keyless channel it leaves behind", async () => {
    h.state = { enabled: true, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };

    const res = await DELETE(request("DELETE"), ctx());

    expect(await res.json()).toEqual({
      ok: true,
      workspaceApiAccess: true,
      workspaceApiHasKey: false,
      internetAccess: false,
    });
    // Closing the channel is the caller's next decision, not a side effect of revoking.
    expect(h.setEnabled).not.toHaveBeenCalled();
  });

  it("refuses rotation when there is no key to replace", async () => {
    h.state = { enabled: true, hasKey: false, createdAt: null, lastUsedAt: null };

    const res = await POST(request("POST", JSON.stringify({ operation: "rotate" })), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "CREDENTIAL_NOT_CONFIGURED" });
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("requires an explicit generation or rotation operation", async () => {
    h.state = { enabled: true, hasKey: false, createdAt: null, lastUsedAt: null };

    const missing = await POST(request("POST"), ctx());
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(h.mint).not.toHaveBeenCalled();
  });

  // Without this, a click or a script meant to create a first key would silently replace one that
  // agents are still authenticating with.
  it("refuses generation when a key already exists", async () => {
    h.state = { enabled: true, hasKey: true, createdAt: "2026-01-01T00:00:00.000Z", lastUsedAt: null };

    const res = await POST(request("POST", JSON.stringify({ operation: "generate" })), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, code: "CREDENTIAL_ALREADY_CONFIGURED" });
    expect(h.mint).not.toHaveBeenCalled();
  });

  it("returns the public error contract when credential persistence fails", async () => {
    h.state = { enabled: true, hasKey: false, createdAt: null, lastUsedAt: null };
    h.mint.mockImplementationOnce(() => {
      throw new Error("disk failure");
    });
    const response = await POST(request("POST", JSON.stringify({ operation: "generate" })), ctx());
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      ok: false,
      code: "INTERNAL_ERROR",
      error: "credential operation failed",
    });
  });

  // Without the workspace guard a mistyped id would mint a key against a workspace that does not
  // exist, leaving an orphan credential record nothing ever cleans up.
  it("refuses every verb for an unknown workspace, minting nothing", async () => {
    h.found = false;
    for (const call of [
      PATCH(request("PATCH", JSON.stringify({ enabled: true })), ctx("missing")),
      POST(request("POST", JSON.stringify({ operation: "rotate" })), ctx("missing")),
      DELETE(request("DELETE"), ctx("missing")),
    ]) {
      expect((await call).status).toBe(404);
    }
    expect(h.mint).not.toHaveBeenCalled();
    expect(h.revoke).not.toHaveBeenCalled();
    expect(h.setEnabled).not.toHaveBeenCalled();
  });
});
