import { describe, expect, it } from "vitest";
import { blockedHosts, enforcedDomains, isValidDomain, normalizeDomain } from "./domain";

describe("normalizeDomain", () => {
  it("reduces a pasted URL to its bare lowercase hostname", () => {
    expect(normalizeDomain("  https://API.OpenAI.com:443/v1/chat?x=1 ")).toBe("api.openai.com");
    expect(normalizeDomain("api.vercel.com.")).toBe("api.vercel.com");
  });
});

describe("isValidDomain", () => {
  it("accepts public hostnames, including pasted URLs", () => {
    for (const domain of ["api.vercel.com", "registry.npmjs.org", "https://api.github.com/repos"]) {
      expect(isValidDomain(domain)).toBe(true);
    }
  });

  it("refuses anything that is not a public hostname", () => {
    for (const domain of ["", "localhost", "example", "not a host", "api_example.com", "10.0.0.1", "*.vercel.com"]) {
      expect(isValidDomain(domain)).toBe(false);
    }
  });
});

describe("enforcedDomains", () => {
  it("enforces a restricted list, an empty one allowing no host", () => {
    expect(enforcedDomains({ restricted: true, domains: ["api.vercel.com"] })).toEqual(["api.vercel.com"]);
    expect(enforcedDomains({ restricted: true, domains: [] })).toEqual([]);
    expect(enforcedDomains({ restricted: false, domains: ["api.vercel.com"] })).toBeNull();
    expect(enforcedDomains(undefined)).toBeNull();
  });
});

describe("blockedHosts", () => {
  it("lists the secret's hosts a restricted allowlist leaves out", () => {
    const allowlist = { restricted: true, domains: ["github.com"] };
    expect(blockedHosts(["github.com", "api.github.com"], allowlist)).toEqual(["api.github.com"]);
    expect(blockedHosts(["github.com"], allowlist)).toEqual([]);
  });

  it("blocks every host of the secret while a restricted list is empty", () => {
    expect(blockedHosts(["api.github.com"], { restricted: true, domains: [] })).toEqual(["api.github.com"]);
  });

  it("blocks nothing when no restriction is enforced", () => {
    expect(blockedHosts(["api.github.com"], { restricted: false, domains: ["github.com"] })).toEqual([]);
    expect(blockedHosts(["api.github.com"], undefined)).toEqual([]);
  });
});
