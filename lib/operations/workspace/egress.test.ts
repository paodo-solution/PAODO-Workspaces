import { describe, expect, it } from "vitest";
import {
  MAX_ALLOWED_DOMAINS,
  resolveDomainAllowlist,
  setDomainAllowlist,
  setInternetAccess,
  validateAllowedDomains,
  validateDomainRestriction,
  validateInternetAccess,
  type EgressServices,
  type EgressWriter,
} from "./egress";
import type { DomainAllowlist } from "@/lib/workspace/types";

const writer = (overrides: Partial<EgressWriter> = {}): EgressWriter => ({
  setWorkspaceInternetAccess: () => true,
  setWorkspaceDomainAllowlist: () => true,
  ...overrides,
});

const services = (overrides: Partial<EgressServices> = {}): EgressServices => ({
  setPolicy: () => {},
  applyToContainer: async () => {},
  ...overrides,
});

describe("setting workspace egress", () => {
  it("persists the setting, enforces it at the proxy with the saved allowlist, and tears down the container", async () => {
    const steps: string[] = [];
    const result = await setInternetAccess(
      "ws-1",
      true,
      false,
      { restricted: true, domains: ["api.vercel.com"] },
      writer({
        setWorkspaceInternetAccess: (_id, enabled) => {
          steps.push(`registry:${enabled}`);
          return true;
        },
      }),
      services({
        setPolicy: (_id, enabled, allowlist) => steps.push(`policy:${enabled}:${allowlist?.domains.join(",")}`),
        applyToContainer: async () => {
          steps.push("stop");
        },
      }),
    );

    expect(steps).toEqual(["registry:true", "policy:true:api.vercel.com", "stop"]);
    expect(result).toEqual({ applied: true });
  });

  // The registry and the proxy policy are one security boundary: a workspace recorded as offline while
  // the proxy still lets it out is worse than a failed request, so the registry write is undone.
  it("rolls the registry back and raises when the proxy rejects the change", async () => {
    const written: boolean[] = [];
    const store = writer({
      setWorkspaceInternetAccess: (_id, enabled) => {
        written.push(enabled);
        return true;
      },
    });

    await expect(
      setInternetAccess(
        "ws-1",
        true,
        false,
        undefined,
        store,
        services({
          setPolicy: () => {
            throw new Error("proxy unavailable");
          },
        }),
      ),
    ).rejects.toThrow("failed to persist internet-access policy");

    expect(written).toEqual([true, false]);
  });

  it("never stops the container when the proxy rejected the change", async () => {
    await expect(
      setInternetAccess(
        "ws-1",
        false,
        true,
        undefined,
        writer(),
        services({
          setPolicy: () => {
            throw new Error("proxy unavailable");
          },
          applyToContainer: async () => {
            throw new Error("must not stop a container after a rolled-back toggle");
          },
        }),
      ),
    ).rejects.toThrow("failed to persist internet-access policy");
  });

  it("rolls back and fails when the container cannot be stopped", async () => {
    const written: boolean[] = [];
    const policies: boolean[] = [];

    await expect(
      setInternetAccess(
        "ws-1",
        false,
        true,
        undefined,
        writer({
          setWorkspaceInternetAccess: (_id, enabled) => {
            written.push(enabled);
            return true;
          },
        }),
        services({
          setPolicy: (_id, enabled) => policies.push(enabled),
          applyToContainer: async () => {
            throw new Error("docker daemon unavailable");
          },
        }),
      ),
    ).rejects.toThrow("failed to apply internet-access setting");

    expect(written).toEqual([false, true]);
    expect(policies).toEqual([false, true]);
  });

  // A store that only refuses unknown ids means the workspace is gone: report not-applied, since touching the
  // proxy would leave a policy entry nothing owns.
  it("reports not-applied without touching the proxy when the registry refuses", async () => {
    const result = await setInternetAccess(
      "ws-1",
      true,
      false,
      undefined,
      writer({ setWorkspaceInternetAccess: () => false }),
      services({
        setPolicy: () => {
          throw new Error("must not set a policy for a workspace the registry refused");
        },
      }),
    );

    expect(result).toEqual({ applied: false });
  });
});

describe("egress input validation", () => {
  it("rejects a non-boolean and names the field", () => {
    expect(() => validateInternetAccess("true")).toThrow("internetAccess must be true or false");
    expect(() => validateInternetAccess(1)).toThrow("internetAccess must be true or false");
  });

  it("returns the boolean it accepted", () => {
    expect(validateInternetAccess(true)).toBe(true);
  });
});

describe("domain allowlist input validation", () => {
  it("normalizes and deduplicates domains, keeping the caller's order", () => {
    expect(validateAllowedDomains(["https://API.Vercel.com/v9", "registry.npmjs.org", "api.vercel.com"])).toEqual([
      "api.vercel.com",
      "registry.npmjs.org",
    ]);
    expect(validateAllowedDomains([])).toEqual([]);
  });

  it("refuses a non-list, a non-hostname and an oversized list", () => {
    expect(() => validateAllowedDomains("api.vercel.com")).toThrow("allowedDomains must be a list of domains");
    for (const bad of [["localhost"], ["10.0.0.1"], [5], ["*.vercel.com"]]) {
      expect(() => validateAllowedDomains(bad)).toThrow("each allowed domain must be a hostname");
    }
    const tooMany = Array.from({ length: MAX_ALLOWED_DOMAINS + 1 }, (_, i) => `h${i}.example.com`);
    expect(() => validateAllowedDomains(tooMany)).toThrow(`at most ${MAX_ALLOWED_DOMAINS}`);
  });

  it("requires a boolean restriction", () => {
    expect(() => validateDomainRestriction("yes")).toThrow("domainRestriction must be true or false");
    expect(validateDomainRestriction(true)).toBe(true);
  });
});

describe("setting the domain allowlist", () => {
  const next: DomainAllowlist = { restricted: true, domains: ["api.vercel.com"] };
  const previous: DomainAllowlist = { restricted: false, domains: [] };

  it("writes the registry, then the policy with the new list, and never touches the container", () => {
    const steps: string[] = [];
    const result = setDomainAllowlist(
      "ws-1",
      next,
      previous,
      true,
      writer({
        setWorkspaceDomainAllowlist: (_id, allowlist) => {
          steps.push(`registry:${allowlist.restricted}`);
          return true;
        },
      }),
      services({
        setPolicy: (_id, enabled, allowlist) => steps.push(`policy:${enabled}:${allowlist?.domains.join(",")}`),
        applyToContainer: async () => {
          throw new Error("must not touch the container");
        },
      }),
    );
    expect(steps).toEqual(["registry:true", "policy:true:api.vercel.com"]);
    expect(result).toEqual({ applied: true });
  });

  it("rolls the registry back and raises when the policy write fails", () => {
    const written: DomainAllowlist[] = [];
    expect(() =>
      setDomainAllowlist(
        "ws-1",
        next,
        previous,
        true,
        writer({
          setWorkspaceDomainAllowlist: (_id, allowlist) => {
            written.push(allowlist);
            return true;
          },
        }),
        services({
          setPolicy: () => {
            throw new Error("disk full");
          },
        }),
      ),
    ).toThrow("failed to persist domain allowlist policy");
    expect(written).toEqual([next, previous]);
  });

  it("reports not-applied without touching the policy when the registry refuses", () => {
    const result = setDomainAllowlist(
      "ws-1",
      next,
      previous,
      true,
      writer({ setWorkspaceDomainAllowlist: () => false }),
      services({
        setPolicy: () => {
          throw new Error("must not set a policy for a workspace the registry refused");
        },
      }),
    );
    expect(result).toEqual({ applied: false });
  });
});

describe("resolving the domain allowlist", () => {
  it("keeps the saved value of a field that wasn't sent", () => {
    const saved: DomainAllowlist = { restricted: true, domains: ["api.vercel.com"] };
    expect(resolveDomainAllowlist(saved, { restricted: false })).toEqual({
      previous: saved,
      next: { restricted: false, domains: ["api.vercel.com"] },
    });
  });

  it("starts from an unrestricted empty list when nothing is saved", () => {
    expect(resolveDomainAllowlist(undefined, { domains: ["a.example.com"] })).toEqual({
      previous: { restricted: false, domains: [] },
      next: { restricted: false, domains: ["a.example.com"] },
    });
  });
});
