// VS Code device tokens: short-lived access, a hard 30-day limit, and refresh-token rotation with reuse
// detection. Every deny path must fail closed.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "device-credentials-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root };
});

vi.mock("../logger", () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
  createAuditLogger: () => ({ info: () => {} }),
}));

import {
  DEVICE_ACCESS_TTL_MS,
  DEVICE_REFRESH_GRACE_MS,
  DEVICE_TTL_MS,
  mint,
  mintDevice,
  revokeDevice,
  rotateDevice,
  setDeviceAccess,
  setEnabled,
  state,
  validate,
  validateDeviceAccess,
} from "./credentialStore";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-16T10:00:00Z");

beforeEach(() => setEnabled("device", null, true));

describe("device tokens", () => {
  it("issues a token pair that identifies the device and nothing else", () => {
    const t = mintDevice(T0);
    expect(t.accessToken).toMatch(new RegExp(`^dat_${t.deviceId}_[0-9a-f]{64}$`));
    expect(t.refreshToken).toMatch(new RegExp(`^drt_${t.deviceId}_[0-9a-f]{64}$`));
    expect(validateDeviceAccess(t.accessToken, T0)).toBe(t.deviceId);
    expect(validateDeviceAccess(t.refreshToken, T0)).toBeNull();
    expect(fs.readFileSync(`${ROOT}/.credentials.json`, "utf-8")).not.toMatch(/dat_|drt_/);
  });

  it("expires the access token after its lifetime", () => {
    const t = mintDevice(T0);
    expect(validateDeviceAccess(t.accessToken, T0 + DEVICE_ACCESS_TTL_MS - 1)).toBe(t.deviceId);
    expect(validateDeviceAccess(t.accessToken, T0 + DEVICE_ACCESS_TTL_MS)).toBeNull();
  });

  it("refuses everything while the switch is off, and resumes when it is back on", () => {
    const t = mintDevice(T0);
    setEnabled("device", null, false);
    expect(validateDeviceAccess(t.accessToken, T0)).toBeNull();
    expect(rotateDevice(t.refreshToken, T0)).toEqual({ ok: false, reason: "disabled" });
    setEnabled("device", null, true);
    expect(validateDeviceAccess(t.accessToken, T0)).toBe(t.deviceId);
  });

  it("rotates both tokens on refresh and keeps the 30-day limit fixed", () => {
    const t = mintDevice(T0);
    const r = rotateDevice(t.refreshToken, T0 + 1000);
    if (!r.ok) throw new Error(r.reason);
    expect(r.tokens.deviceId).toBe(t.deviceId);
    expect(r.tokens.refreshToken).not.toBe(t.refreshToken);
    expect(r.tokens.expiresAt).toBe(t.expiresAt);
    expect(validateDeviceAccess(t.accessToken, T0 + 1000)).toBeNull();
    expect(validateDeviceAccess(r.tokens.accessToken, T0 + 1000)).toBe(t.deviceId);
  });

  it("answers superseded to a second window within the grace, and revokes a replay after it", () => {
    const t = mintDevice(T0);
    const first = rotateDevice(t.refreshToken, T0);
    if (!first.ok) throw new Error(first.reason);
    expect(rotateDevice(t.refreshToken, T0 + DEVICE_REFRESH_GRACE_MS)).toEqual({ ok: false, reason: "superseded" });
    expect(validateDeviceAccess(first.tokens.accessToken, T0 + 1)).toBe(t.deviceId);

    expect(rotateDevice(t.refreshToken, T0 + DEVICE_REFRESH_GRACE_MS + 1)).toEqual({ ok: false, reason: "invalid" });
    expect(validateDeviceAccess(first.tokens.accessToken, T0 + 2)).toBeNull();
  });

  it("refuses a forged secret for a known device without revoking it", () => {
    const t = mintDevice(T0);
    expect(rotateDevice(`drt_${t.deviceId}_${"0".repeat(64)}`, T0)).toEqual({ ok: false, reason: "invalid" });
    expect(validateDeviceAccess(`dat_${t.deviceId}_${"0".repeat(64)}`, T0)).toBeNull();
    expect(validateDeviceAccess(t.accessToken, T0)).toBe(t.deviceId);
  });

  it("forgets a device at its hard limit, even if it was refreshed every day", () => {
    const t = mintDevice(T0);
    let refresh = t.refreshToken;
    for (let day = 1; day < 30; day++) {
      const r = rotateDevice(refresh, T0 + day * 24 * 60 * 60_000);
      if (!r.ok) throw new Error(r.reason);
      refresh = r.tokens.refreshToken;
    }
    expect(rotateDevice(refresh, T0 + DEVICE_TTL_MS)).toEqual({ ok: false, reason: "expired" });
    expect(fs.readFileSync(`${ROOT}/.credentials.json`, "utf-8")).not.toContain(`device:${t.deviceId}`);
  });

  it("revokes one device without touching the others", () => {
    const a = mintDevice(T0);
    const b = mintDevice(T0);
    expect(revokeDevice(a.deviceId)).toBe(true);
    expect(revokeDevice(a.deviceId)).toBe(false);
    expect(validateDeviceAccess(a.accessToken, T0)).toBeNull();
    expect(validateDeviceAccess(b.accessToken, T0)).toBe(b.deviceId);
  });

  it("signs out every device when VS Code connections are turned off", () => {
    const a = mintDevice(T0);
    const b = mintDevice(T0);
    setDeviceAccess(false);
    setDeviceAccess(true);
    expect(validateDeviceAccess(a.accessToken, T0)).toBeNull();
    expect(rotateDevice(b.refreshToken, T0)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses malformed tokens", () => {
    for (const bad of [
      "",
      "dat_",
      "dat_xyz_" + "a".repeat(64),
      "cli_" + "a".repeat(64),
      "dat_0123456789abcdef_short",
    ]) {
      expect(validateDeviceAccess(bad, T0)).toBeNull();
      expect(rotateDevice(bad, T0)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("leaves the existing channels alone", () => {
    const cli = mint("platform");
    setEnabled("platform", null, true);
    mintDevice(T0);
    expect(validate("platform", null, cli)).toBe(true);
    expect(state("device")).toMatchObject({ enabled: true, hasKey: false });
    expect(() => mint("device")).toThrow();
  });
});

// Bug repro: a refresh the server completed but whose answer never reached VS Code (Wi-Fi drop, laptop
// asleep). VS Code still holds only the old refresh token, and retries with it on the next action.
describe("a refresh whose response was lost on the network", () => {
  it("lets VS Code recover with the token it still has, instead of signing it out", () => {
    const t = mintDevice(T0);
    const lost = rotateDevice(t.refreshToken, T0 + 8 * 60 * 60_000);
    expect(lost.ok).toBe(true); // the server rotated; this answer is the one that never arrived

    // Two minutes later the user clicks something; VS Code retries with the only token it has.
    const retry = rotateDevice(t.refreshToken, T0 + 8 * 60 * 60_000 + 2 * 60_000);
    expect(retry).toMatchObject({ ok: true });
    // The pair that never arrived is dead; the recovered one works.
    if (!lost.ok || !retry.ok) throw new Error("unreachable");
    const later = T0 + 8 * 60 * 60_000 + 3 * 60_000;
    expect(validateDeviceAccess(lost.tokens.accessToken, later)).toBeNull();
    expect(validateDeviceAccess(retry.tokens.accessToken, later)).toBe(t.deviceId);
  });

  it("recovers even if the answer is lost twice in a row", () => {
    const t = mintDevice(T0);
    expect(rotateDevice(t.refreshToken, T0).ok).toBe(true);
    expect(rotateDevice(t.refreshToken, T0 + 2 * 60_000).ok).toBe(true);
    expect(rotateDevice(t.refreshToken, T0 + 4 * 60_000).ok).toBe(true);
  });

  it("still revokes when the new pair was used: the old token can only be a copy", () => {
    const t = mintDevice(T0);
    const rotated = rotateDevice(t.refreshToken, T0);
    if (!rotated.ok) throw new Error(rotated.reason);
    expect(validateDeviceAccess(rotated.tokens.accessToken, T0 + 1000)).toBe(t.deviceId);

    expect(rotateDevice(t.refreshToken, T0 + 2 * 60_000)).toEqual({ ok: false, reason: "invalid" });
    expect(validateDeviceAccess(rotated.tokens.accessToken, T0 + 2 * 60_000)).toBeNull();
  });

  it("still answers superseded during the grace, for two windows refreshing at once", () => {
    const t = mintDevice(T0);
    expect(rotateDevice(t.refreshToken, T0).ok).toBe(true);
    expect(rotateDevice(t.refreshToken, T0 + 30_000)).toEqual({ ok: false, reason: "superseded" });
  });
});
