import { describe, expect, it } from "vitest";
import { enforcedDomains, isValidDomain, normalizeDomain } from "./domain";

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
  it("enforces a restricted list only once it has a domain", () => {
    expect(enforcedDomains({ restricted: true, domains: ["api.vercel.com"] })).toEqual(["api.vercel.com"]);
    expect(enforcedDomains({ restricted: true, domains: [] })).toBeNull();
    expect(enforcedDomains({ restricted: false, domains: ["api.vercel.com"] })).toBeNull();
    expect(enforcedDomains(undefined)).toBeNull();
  });
});
