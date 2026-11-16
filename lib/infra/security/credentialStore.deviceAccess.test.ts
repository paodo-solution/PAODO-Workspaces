// Bug repro: turning VS Code access off must sign every device out for good, even if the disk fails
// half-way, so that turning access back on later never brings an old device back.
import { afterAll, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

const { ROOT, disk } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "device-access-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root, disk: { writes: 0, failAt: 0 } };
});

vi.mock("../logger", () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
  createAuditLogger: () => ({ info: () => {} }),
}));

// The real write, except the one numbered `failAt`, which fails as a full disk would.
vi.mock("../jsonPersist", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jsonPersist")>();
  return {
    ...actual,
    atomicSaveJson: (file: string, data: unknown) => {
      disk.writes += 1;
      if (disk.writes === disk.failAt)
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      actual.atomicSaveJson(file, data);
    },
  };
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// The app restarting: the in-memory store is dropped and read back from .credentials.json.
async function restart() {
  delete (global as { __singletons?: Record<string, unknown> }).__singletons?.credentials;
  vi.resetModules();
  return import("./credentialStore");
}

// Fails the first write of the switch-off, then the second, so the test holds however many writes it takes.
it.each([1, 2])("never half-applies turning access off when write %i fails", async (failAt) => {
  const store = await restart();
  store.setDeviceAccess(true);
  const laptop = store.mintDevice();

  disk.writes = 0;
  disk.failAt = failAt;
  let failed = false;
  try {
    store.setDeviceAccess(false);
  } catch {
    failed = true;
  }
  disk.failAt = 0;

  // On disk: never "access off" while the laptop is still there.
  const saved = JSON.parse(fs.readFileSync(path.join(ROOT, ".credentials.json"), "utf-8"));
  const savedOff = saved.device?.enabled === false;
  const savedLaptop = `device:${laptop.deviceId}` in saved;
  expect(savedOff && savedLaptop).toBe(false);

  // In memory: the same state as on disk, so the app behaves as it will after a restart.
  expect(store.deviceAccessEnabled()).toBe(!savedOff);
  expect(store.validateDeviceAccess(laptop.accessToken) !== null).toBe(savedLaptop);

  // After a restart and access turned back on, the laptop is back only if the switch-off never happened.
  const restarted = await restart();
  restarted.setDeviceAccess(true);
  expect(restarted.validateDeviceAccess(laptop.accessToken) !== null).toBe(failed);
});

// The "new pair was used" mark is what tells a stolen refresh token from a lost answer: a restart must not
// forget it, or a copy replayed after a restart would be given fresh tokens.
it("remembers across a restart that the new pair was used, so a copied refresh token is still revoked", async () => {
  const store = await restart();
  store.setDeviceAccess(true);
  const t = store.mintDevice();
  const rotated = store.rotateDevice(t.refreshToken);
  if (!rotated.ok) throw new Error(rotated.reason);
  expect(store.validateDeviceAccess(rotated.tokens.accessToken)).toBe(t.deviceId);

  const restarted = await restart();
  const replay = restarted.rotateDevice(t.refreshToken, Date.now() + 2 * 60_000);
  expect(replay).toEqual({ ok: false, reason: "invalid" });
  expect(restarted.validateDeviceAccess(rotated.tokens.accessToken)).toBeNull();
});
