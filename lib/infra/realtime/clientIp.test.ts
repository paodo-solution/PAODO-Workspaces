import { describe, expect, it } from "vitest";
import { getClientIp } from "./clientIp";

const req = (headers: Record<string, string>) => ({ headers: new Headers(headers) });

describe("getClientIp", () => {
  it("reads cf-connecting-ip", () => {
    expect(getClientIp(req({ "cf-connecting-ip": " 9.9.9.9 " }))).toBe("9.9.9.9");
  });

  it("ignores forwarding headers no hop sanitizes", () => {
    // The edge strips both and never re-sets them, so a value here is caller-chosen; trusting it would forge the
    // audit trail and dodge the per-IP rate limits.
    expect(getClientIp(req({ "x-real-ip": "203.0.113.99", "x-forwarded-for": "203.0.113.99" }))).toBe("unknown");
  });

  it("reports unknown rather than guessing when no trusted header is present", () => {
    expect(getClientIp(req({}))).toBe("unknown");
    expect(getClientIp(req({ "cf-connecting-ip": "" }))).toBe("unknown");
  });
});
