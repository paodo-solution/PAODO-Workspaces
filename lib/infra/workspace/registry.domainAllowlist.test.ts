import { describe, expect, it, vi } from "vitest";
import { WorkspaceStore } from "./registry";

const legacy = { id: "w1", name: "workspace", createdAt: "2026-01-01T00:00:00.000Z" };

describe("WorkspaceStore domainAllowlist", () => {
  it("leaves records without one unrestricted", () => {
    const store = new WorkspaceStore({ load: () => [legacy], persist: vi.fn() });
    expect(store.getWorkspace("w1")?.domainAllowlist).toBeUndefined();
  });

  it("persists the allowlist and reloads it, including a kept list while not restricted", () => {
    const persist = vi.fn();
    const store = new WorkspaceStore({ load: () => [legacy], persist });

    expect(store.setWorkspaceDomainAllowlist("w1", { restricted: false, domains: ["api.vercel.com"] })).toBe(true);
    const saved = persist.mock.calls.at(-1)?.[0];
    expect(saved).toEqual([
      expect.objectContaining({ id: "w1", domainAllowlist: { restricted: false, domains: ["api.vercel.com"] } }),
    ]);

    const reloaded = new WorkspaceStore({ load: () => JSON.parse(JSON.stringify(saved)), persist: vi.fn() });
    expect(reloaded.getWorkspace("w1")?.domainAllowlist).toEqual({ restricted: false, domains: ["api.vercel.com"] });
  });

  it("copies the domains, so a caller mutating its array cannot change the stored list", () => {
    const store = new WorkspaceStore({ load: () => [legacy], persist: vi.fn() });
    const domains = ["api.vercel.com"];
    store.setWorkspaceDomainAllowlist("w1", { restricted: true, domains });
    domains.push("example.com");
    expect(store.getWorkspace("w1")?.domainAllowlist?.domains).toEqual(["api.vercel.com"]);
  });

  it("restricts only the workspace whose saved allowlist is malformed to no domains", () => {
    const store = new WorkspaceStore({
      load: () => [
        { ...legacy, domainAllowlist: { restricted: "yes" } as never },
        { ...legacy, id: "w2", domainAllowlist: { restricted: true, domains: ["api.vercel.com"] } },
      ],
      persist: vi.fn(),
    });
    expect(store.getWorkspace("w1")?.domainAllowlist).toEqual({ restricted: true, domains: [] });
    expect(store.getWorkspace("w2")?.domainAllowlist).toEqual({ restricted: true, domains: ["api.vercel.com"] });
  });

  it("refuses an unknown workspace", () => {
    const store = new WorkspaceStore({ load: () => [], persist: vi.fn() });
    expect(store.setWorkspaceDomainAllowlist("missing", { restricted: true, domains: [] })).toBe(false);
  });
});
