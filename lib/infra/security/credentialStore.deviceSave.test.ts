// A failed disk write while issuing device tokens must leave the device exactly as it was: the caller never
// received the new tokens, so the old ones must keep working, and a retry must not look like token theft.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

const { ROOT, failNextSave } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "device-save-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root, failNextSave: { value: false } };
});

vi.mock("../jsonPersist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jsonPersist")>();
  return {
    ...actual,
    atomicSaveJson: (filePath: string, data: unknown) => {
      if (failNextSave.value) {
        failNextSave.value = false;
        throw new Error("ENOSPC: no space left on device");
      }
      actual.atomicSaveJson(filePath, data);
    },
  };
});

vi.mock("../logger", () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
  createAuditLogger: () => ({ info: () => {} }),
}));

import {
  DEVICE_REFRESH_GRACE_MS,
  DEVICE_TTL_MS,
  mintDevice,
  rotateDevice,
  setEnabled,
  validateDeviceAccess,
} from "./credentialStore";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const T0 = Date.parse("2026-11-16T10:00:00Z");

beforeEach(() => {
  failNextSave.value = false;
  setEnabled("device", null, true);
});

describe("a failed save while rotating device tokens", () => {
  it("keeps the old access token working", () => {
    const t = mintDevice(T0);
    failNextSave.value = true;
    expect(() => rotateDevice(t.refreshToken, T0 + 1000)).toThrow();
    expect(validateDeviceAccess(t.accessToken, T0 + 2000)).toBe(t.deviceId);
  });

  it("lets the client retry its refresh token at once", () => {
    const t = mintDevice(T0);
    failNextSave.value = true;
    expect(() => rotateDevice(t.refreshToken, T0 + 1000)).toThrow();
    expect(rotateDevice(t.refreshToken, T0 + 2000).ok).toBe(true);
  });

  it("does not revoke the device when the client retries after the grace period", () => {
    const t = mintDevice(T0);
    failNextSave.value = true;
    expect(() => rotateDevice(t.refreshToken, T0 + 1000)).toThrow();
    const retry = rotateDevice(t.refreshToken, T0 + 1000 + DEVICE_REFRESH_GRACE_MS + 1);
    expect(retry.ok).toBe(true);
  });
});

describe("a failed save while approving a device", () => {
  it("leaves no device behind whose tokens nobody received", () => {
    const devicesOnDisk = () =>
      Object.keys(JSON.parse(fs.readFileSync(`${ROOT}/.credentials.json`, "utf-8")) as Record<string, unknown>)
        .filter((key) => key.startsWith("device:"))
        .sort();
    mintDevice(T0); // makes sure the file exists
    const before = devicesOnDisk();
    failNextSave.value = true;
    expect(() => mintDevice(T0)).toThrow();
    const next = mintDevice(T0); // this write persists whatever memory holds
    expect(devicesOnDisk()).toEqual([...before, `device:${next.deviceId}`].sort());
  });
});

describe("a failed save while forgetting an expired device", () => {
  it("refuses the token instead of throwing on the request path", () => {
    const t = mintDevice(T0);
    failNextSave.value = true;
    expect(() => validateDeviceAccess(t.accessToken, T0 + DEVICE_TTL_MS)).not.toThrow();
  });
});
