// Registry, proxy policy and network are one boundary, so an unconfirmed step rolls the whole change back. The
// toggle rebuilds the network around a running container and must never stop it: that once wiped every install.
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  workspace: { id: "ws-1", name: "Alpha", internetAccess: false } as Record<string, unknown>,
  setWorkspaceInternetAccess: vi.fn(),
  setWorkspaceDomainAllowlist: vi.fn(),
  setInternetAccessPolicy: vi.fn(),
  applyInternetAccess: vi.fn(async () => {}),
}));

vi.mock("@/lib/api/guards", () => ({
  requireWorkspace: () => h.workspace,
}));
vi.mock("@/lib/infra/workspace/registry", () => ({
  setWorkspaceInternetAccess: h.setWorkspaceInternetAccess,
}));
vi.mock("@/lib/infra/proxy/internetAccessPolicy", () => ({
  setInternetAccessPolicy: h.setInternetAccessPolicy,
}));
vi.mock("@/lib/infra/services", () => ({
  getStore: () => ({
    getWorkspace: () => h.workspace,
    setWorkspaceInternetAccess: h.setWorkspaceInternetAccess,
    setWorkspaceDomainAllowlist: h.setWorkspaceDomainAllowlist,
  }),
  getContainers: () => ({ applyInternetAccess: h.applyInternetAccess }),
}));

import { GET, PATCH } from "./route";

const ctx = () => ({ params: Promise.resolve({ id: "ws-1" }) });
const request = (body?: unknown) =>
  new Request("http://x/api/workspaces/ws-1/internet-access", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never;

beforeEach(() => {
  h.workspace = { id: "ws-1", name: "Alpha", internetAccess: false };
  h.setWorkspaceInternetAccess.mockReset().mockImplementation((_id: string, enabled: boolean) => {
    h.workspace.internetAccess = enabled;
    return true;
  });
  h.setInternetAccessPolicy.mockReset();
  h.setWorkspaceDomainAllowlist.mockReset().mockImplementation((_id: string, allowlist: unknown) => {
    h.workspace.domainAllowlist = allowlist;
    return true;
  });
  h.applyInternetAccess.mockReset().mockImplementation(async () => {});
});

describe("PATCH /api/workspaces/[id]/internet-access", () => {
  it("rejects a non-boolean body with the shared error envelope", async () => {
    const res = await PATCH(request({ enabled: "yes" }), ctx());
    expect(res.status).toBe(400);
    // The envelope, not a bare { error }: a programmatic caller branches on `code`, and the message
    // is the shared validator's, so this route and a workspace PATCH refuse identically.
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "WORKSPACE_UPDATE_INVALID",
      error: "internetAccess must be true or false",
    });
    expect(h.setWorkspaceInternetAccess).not.toHaveBeenCalled();
  });

  it("rejects a malformed body instead of throwing out of the handler", async () => {
    const malformed = new Request("http://x/api/workspaces/ws-1/internet-access", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    }) as never;
    const res = await PATCH(malformed, ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
    expect(h.setWorkspaceInternetAccess).not.toHaveBeenCalled();
  });

  it("toggles the store and the policy file, and applies the new policy to the network", async () => {
    const res = await PATCH(request({ enabled: true }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: { internetAccess: true },
    });
    expect(h.setWorkspaceInternetAccess).toHaveBeenCalledWith("ws-1", true);
    expect(h.setInternetAccessPolicy).toHaveBeenCalledWith("ws-1", true, undefined);
    // Carries the new value, so the network is rebuilt with the right --internal flag directly
    // rather than being left for a later container bring-up to reconcile.
    expect(h.applyInternetAccess).toHaveBeenCalledWith("ws-1", true);
  });

  it("hands the policy the saved allowlist, so turning internet back on restores the restriction", async () => {
    const domainAllowlist = { restricted: true, domains: ["api.vercel.com"] };
    h.workspace = { ...h.workspace, domainAllowlist };
    await PATCH(request({ enabled: true }), ctx());
    expect(h.setInternetAccessPolicy).toHaveBeenCalledWith("ws-1", true, domainAllowlist);
  });

  it("rolls back the store field when the policy-file write fails", async () => {
    h.setInternetAccessPolicy.mockImplementation(() => {
      throw new Error("disk full");
    });
    const res = await PATCH(request({ enabled: true }), ctx());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, code: "WORKSPACE_UPDATE_FAILED" });
    // Called once to set true, once to roll back to the previous value (false).
    expect(h.setWorkspaceInternetAccess).toHaveBeenNthCalledWith(1, "ws-1", true);
    expect(h.setWorkspaceInternetAccess).toHaveBeenNthCalledWith(2, "ws-1", false);
    expect(h.applyInternetAccess).not.toHaveBeenCalled();
  });

  it("rolls back and fails when the network cannot be rebuilt", async () => {
    h.applyInternetAccess.mockImplementation(async () => {
      throw new Error("docker daemon unreachable");
    });
    const res = await PATCH(request({ enabled: true }), ctx());
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      ok: false,
      code: "WORKSPACE_UPDATE_FAILED",
      error: "failed to apply internet-access setting",
    });
    expect(h.setWorkspaceInternetAccess).toHaveBeenNthCalledWith(1, "ws-1", true);
    expect(h.setWorkspaceInternetAccess).toHaveBeenNthCalledWith(2, "ws-1", false);
    expect(h.setInternetAccessPolicy).toHaveBeenNthCalledWith(1, "ws-1", true, undefined);
    expect(h.setInternetAccessPolicy).toHaveBeenNthCalledWith(2, "ws-1", false, undefined);
  });
});

describe("domain allowlist through /internet-access", () => {
  it("GET reports an unrestricted workspace with an empty list", async () => {
    const res = await GET(new Request("http://x/api/workspaces/ws-1/internet-access") as never, ctx());
    expect(await res.json()).toEqual({ enabled: false, domainRestriction: false, allowedDomains: [] });
  });

  it("PATCH saves the list and the restriction, enforces them at the proxy, and leaves the network alone", async () => {
    h.workspace.internetAccess = true;
    const res = await PATCH(request({ domainRestriction: true, allowedDomains: ["API.vercel.com"] }), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      workspaceId: "ws-1",
      applied: { domainRestriction: true, allowedDomains: ["api.vercel.com"] },
    });
    const allowlist = { restricted: true, domains: ["api.vercel.com"] };
    expect(h.setWorkspaceDomainAllowlist).toHaveBeenCalledWith("ws-1", allowlist);
    expect(h.setInternetAccessPolicy).toHaveBeenCalledWith("ws-1", true, allowlist);
    expect(h.applyInternetAccess).not.toHaveBeenCalled();
  });

  it("PATCH refuses an invalid domain with the shared envelope and writes nothing", async () => {
    const res = await PATCH(request({ allowedDomains: ["localhost"] }), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "WORKSPACE_UPDATE_INVALID" });
    expect(h.setWorkspaceDomainAllowlist).not.toHaveBeenCalled();
  });

  it("PATCH refuses a body with none of its fields", async () => {
    const res = await PATCH(request({}), ctx());
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, code: "INVALID_REQUEST" });
  });
});
