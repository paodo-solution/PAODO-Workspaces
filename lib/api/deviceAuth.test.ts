// Only a device token that stopped validating counts as a lost sign-in; every other caller is left alone.
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/infra/security/credentialStore", () => ({
  validateDeviceAccess: (plain: string) => (plain === "dat_valid" ? "d1" : null),
}));
vi.mock("@/lib/api/credentialRoutes", () => ({ publicBaseUrl: () => null }));

import { deviceSignInLost } from "./deviceAuth";

const withAuth = (authorization?: string) =>
  new Request("http://localhost/x", authorization ? { headers: { authorization } } : {});

describe("deviceSignInLost", () => {
  it("is false without a device token", () => {
    expect(deviceSignInLost(withAuth())).toBe(false);
    expect(deviceSignInLost(withAuth("Bearer cli_abc"))).toBe(false);
    expect(deviceSignInLost(withAuth("Basic dXNlcjpwYXNz"))).toBe(false);
  });

  it("is false for a device token that still validates", () => {
    expect(deviceSignInLost(withAuth("Bearer dat_valid"))).toBe(false);
  });

  it("is true for a device token that no longer validates", () => {
    expect(deviceSignInLost(withAuth("Bearer dat_revoked"))).toBe(true);
  });
});
