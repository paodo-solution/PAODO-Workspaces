// One-time sign-in codes: S256 only, single use, 60 seconds, and a replayed code revokes what it produced.
import { describe, expect, it, vi } from "vitest";
import { CONNECT_CODE_TTL_MS, createConnectCode, redeemConnectCode, s256 } from "./connectCodes";

const T0 = 1_000_000;
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const issue = vi.fn(() => ({ deviceId: "dev-1" }));

describe("connect codes", () => {
  it("matches the RFC 7636 test vector", () => {
    expect(s256(VERIFIER)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("redeems once with the right verifier", () => {
    const code = createConnectCode(s256(VERIFIER), T0);
    expect(redeemConnectCode(code, VERIFIER, issue, T0 + 1)).toEqual({ status: "ok", result: { deviceId: "dev-1" } });
  });

  it("reports a second redemption with the device to revoke", () => {
    const code = createConnectCode(s256(VERIFIER), T0);
    redeemConnectCode(code, VERIFIER, issue, T0);
    expect(redeemConnectCode(code, VERIFIER, issue, T0)).toEqual({ status: "reused", deviceId: "dev-1" });
    expect(redeemConnectCode(code, VERIFIER, issue, T0)).toEqual({ status: "invalid" });
  });

  it("burns the code on a wrong verifier, so it cannot be guessed at", () => {
    const code = createConnectCode(s256(VERIFIER), T0);
    const calls = issue.mock.calls.length;
    expect(redeemConnectCode(code, VERIFIER.replace("d", "e"), issue, T0)).toEqual({ status: "invalid" });
    expect(redeemConnectCode(code, VERIFIER, issue, T0)).toEqual({ status: "invalid" });
    expect(issue.mock.calls.length).toBe(calls);
  });

  it("expires after 60 seconds", () => {
    const code = createConnectCode(s256(VERIFIER), T0);
    expect(redeemConnectCode(code, VERIFIER, issue, T0 + CONNECT_CODE_TTL_MS)).toEqual({ status: "invalid" });
  });

  it("refuses a verifier that is not RFC 7636 shaped, even if it hashes right", () => {
    const short = "too-short";
    const code = createConnectCode(s256(short), T0);
    expect(redeemConnectCode(code, short, issue, T0)).toEqual({ status: "invalid" });
  });
});
