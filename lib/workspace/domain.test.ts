import { describe, expect, it } from "vitest";
import {
  blockedHosts,
  egressWarning,
  enforcedDomains,
  hostMatches,
  isHostAllowed,
  isValidDomain,
  normalizeDomain,
} from "./domain";

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

describe("egressWarning", () => {
  const listed = { restricted: true, domains: ["github.com", "api.vercel.com"] };
  const empty = { restricted: true, domains: [] };
  const open = { restricted: false, domains: ["github.com"] };

  it("says an allowlist sent while offline is saved for later, and whether it will block every host", () => {
    expect(egressWarning(false, listed, { domainRestriction: true })).toBe(
      "internetAccess is false: the allowlist is saved and applies once internetAccess is true",
    );
    expect(egressWarning(false, open, { domainRestriction: false })).toMatch(/^internetAccess is false: /);
    expect(egressWarning(false, empty, { allowedDomains: [] })).toMatch(
      /, and with no allowed domain it will then block every host$/,
    );
  });

  it("names the saved hosts to an update that turns internet on without sending the list", () => {
    expect(egressWarning(true, listed, { internetAccess: true })).toBe(
      "domainRestriction is on: only github.com, api.vercel.com are reachable",
    );
    expect(egressWarning(true, { restricted: true, domains: ["github.com"] }, { internetAccess: true })).toBe(
      "domainRestriction is on: only github.com is reachable",
    );
  });

  it("names a restored list to an update that turns the restriction on without sending it", () => {
    expect(egressWarning(true, listed, { domainRestriction: true })).toMatch(/only github.com, api.vercel.com are/);
  });

  it("counts the hosts instead of naming them past ten", () => {
    const many = { restricted: true, domains: Array.from({ length: 11 }, (_, i) => `h${i}.example.com`) };
    expect(egressWarning(true, many, { internetAccess: true })).toBe(
      "domainRestriction is on: only the 11 allowedDomains are reachable",
    );
  });

  it("warns whenever an egress update leaves the restriction on with no domain", () => {
    for (const sent of [{ internetAccess: true }, { domainRestriction: true }, { allowedDomains: [] }]) {
      expect(egressWarning(true, empty, sent)).toMatch(/^No allowed domain is set: /);
    }
  });

  it("stays silent when the sent fields already say what is reachable", () => {
    expect(
      egressWarning(true, listed, { internetAccess: true, domainRestriction: true, allowedDomains: listed.domains }),
    ).toBeUndefined();
    expect(egressWarning(true, listed, { allowedDomains: listed.domains })).toBeUndefined();
    expect(egressWarning(false, listed, { internetAccess: false })).toBeUndefined();
    expect(egressWarning(false, empty, { internetAccess: false })).toBeUndefined();
    expect(egressWarning(true, open, { internetAccess: true })).toBeUndefined();
    expect(egressWarning(true, undefined, { internetAccess: true })).toBeUndefined();
  });

  it("stays silent for an update that sends no egress field", () => {
    expect(egressWarning(true, listed, {})).toBeUndefined();
    expect(egressWarning(true, empty, {})).toBeUndefined();
  });
});

describe("hostMatches (exact-host scoping)", () => {
  it("matches the exact host", () => {
    expect(hostMatches("api.openai.com", "api.openai.com")).toBe(true);
  });

  it("is case-insensitive on the request host", () => {
    expect(hostMatches("API.OpenAI.com", "api.openai.com")).toBe(true);
  });

  it("is case-insensitive on the scoped domain too", () => {
    expect(hostMatches("api.openai.com", "API.OpenAI.com")).toBe(true);
  });

  it("does NOT match a subdomain of the scoped host", () => {
    expect(hostMatches("evil.api.openai.com", "api.openai.com")).toBe(false);
  });

  it("does NOT let an apex rule cover a subdomain", () => {
    expect(hostMatches("api.openai.com", "openai.com")).toBe(false);
  });

  it("does not match unrelated hosts", () => {
    expect(hostMatches("api.evil.com", "api.openai.com")).toBe(false);
  });
});

describe("isHostAllowed (domain allowlist)", () => {
  it("lets everything through when the workspace isn't restricted", () => {
    expect(isHostAllowed(null, "anything.example.com")).toBe(true);
  });

  it("matches listed hosts exactly, ignoring case and a trailing dot", () => {
    const allowed = ["api.vercel.com"];
    expect(isHostAllowed(allowed, "API.Vercel.com.")).toBe(true);
    expect(isHostAllowed(allowed, "vercel.com")).toBe(false);
    expect(isHostAllowed(allowed, "evil.api.vercel.com")).toBe(false);
    expect(isHostAllowed([], "api.vercel.com")).toBe(false);
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
