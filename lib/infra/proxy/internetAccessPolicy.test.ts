// A false positive reopens an "off" workspace's only route out. Pins default-on, the persisted round-trip,
// and keeping last-known-good on read failure (resetting to empty would fail OPEN here).

import { describe, it, expect, vi, afterAll, afterEach } from "vitest";
import fs from "fs";

// Redirect the on-disk store to a throwaway temp dir BEFORE the module (via paths.ts) reads
// WORKSPACES_ROOT at import time — mirrors credentialStore.test.ts.
const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "internet-access-policy-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root };
});

import {
  setInternetAccessPolicy,
  isInternetAccessEnabled,
  deleteInternetAccessPolicy,
  reloadInternetAccessPolicy,
  allowedDomainsFor,
  INTERNET_ACCESS_POLICY_FILE,
} from "./internetAccessPolicy";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("isInternetAccessEnabled — defaults", () => {
  it("is enabled by default for a workspace never toggled", () => {
    expect(isInternetAccessEnabled("never-toggled")).toBe(true);
  });
});

describe("setInternetAccessPolicy / isInternetAccessEnabled round-trip", () => {
  it("disables and re-enables a workspace", () => {
    setInternetAccessPolicy("ws-toggle", false);
    expect(isInternetAccessEnabled("ws-toggle")).toBe(false);
    setInternetAccessPolicy("ws-toggle", true);
    expect(isInternetAccessEnabled("ws-toggle")).toBe(true);
  });

  it("persists to disk as a sparse file (only off entries)", () => {
    setInternetAccessPolicy("ws-sparse-off", false);
    setInternetAccessPolicy("ws-sparse-on", true); // on is the default — should not add an entry
    const onDisk = JSON.parse(fs.readFileSync(INTERNET_ACCESS_POLICY_FILE, "utf-8"));
    expect(onDisk["ws-sparse-off"]).toBe(false);
    expect(onDisk).not.toHaveProperty("ws-sparse-on");
  });

  it("does not affect other workspaces", () => {
    setInternetAccessPolicy("ws-a", false);
    expect(isInternetAccessEnabled("ws-b")).toBe(true);
  });
});

describe("setInternetAccessPolicy with a domain allowlist", () => {
  const onDisk = () => JSON.parse(fs.readFileSync(INTERNET_ACCESS_POLICY_FILE, "utf-8"));

  it("writes the hosts of a restricted workspace and reads them back", () => {
    setInternetAccessPolicy("ws-restricted", true, { restricted: true, domains: ["api.vercel.com"] });
    expect(onDisk()["ws-restricted"]).toEqual(["api.vercel.com"]);
    expect(isInternetAccessEnabled("ws-restricted")).toBe(true);
    expect(allowedDomainsFor("ws-restricted")).toEqual(["api.vercel.com"]);
  });

  it("writes nothing for a restriction with no domains yet, which enforces nothing", () => {
    setInternetAccessPolicy("ws-empty", true, { restricted: true, domains: [] });
    expect(onDisk()).not.toHaveProperty("ws-empty");
    expect(allowedDomainsFor("ws-empty")).toBeNull();
  });

  it("writes nothing for a kept list while the restriction is off", () => {
    setInternetAccessPolicy("ws-kept", true, { restricted: false, domains: ["api.vercel.com"] });
    expect(onDisk()).not.toHaveProperty("ws-kept");
    expect(allowedDomainsFor("ws-kept")).toBeNull();
  });

  it("lets internet off win over the allowlist", () => {
    setInternetAccessPolicy("ws-off-restricted", false, { restricted: true, domains: ["api.vercel.com"] });
    expect(isInternetAccessEnabled("ws-off-restricted")).toBe(false);
    expect(allowedDomainsFor("ws-off-restricted")).toBeNull();
  });

  it("restores the restriction when internet access is turned back on", () => {
    const allowlist = { restricted: true, domains: ["api.vercel.com"] };
    setInternetAccessPolicy("ws-reenabled", false, allowlist);
    setInternetAccessPolicy("ws-reenabled", true, allowlist);
    expect(allowedDomainsFor("ws-reenabled")).toEqual(["api.vercel.com"]);
  });
});

describe("deleteInternetAccessPolicy", () => {
  it("removes a workspace's entry, reverting it to the default-enabled state", () => {
    setInternetAccessPolicy("ws-delete", false);
    expect(isInternetAccessEnabled("ws-delete")).toBe(false);
    deleteInternetAccessPolicy("ws-delete");
    expect(isInternetAccessEnabled("ws-delete")).toBe(true);
  });

  it("is a no-op for a workspace with no entry", () => {
    expect(() => deleteInternetAccessPolicy("ws-never-existed")).not.toThrow();
  });
});

describe("reloadInternetAccessPolicy", () => {
  afterEach(() => {
    // Restore the file to a known-good, parseable state so later tests (and the next reload) aren't
    // left reading the corrupted content this suite intentionally writes.
    fs.writeFileSync(INTERNET_ACCESS_POLICY_FILE, JSON.stringify({}));
    reloadInternetAccessPolicy();
  });

  it("picks up an externally-written change (simulates the sidecar reading the app's write)", () => {
    fs.writeFileSync(INTERNET_ACCESS_POLICY_FILE, JSON.stringify({ "ws-external": false }));
    reloadInternetAccessPolicy();
    expect(isInternetAccessEnabled("ws-external")).toBe(false);
  });

  it("on a corrupt file, keeps the last-known-good state instead of failing open", () => {
    setInternetAccessPolicy("ws-protected", false);
    fs.writeFileSync(INTERNET_ACCESS_POLICY_FILE, "{ not valid json");
    reloadInternetAccessPolicy();
    // The whole point: a transient/corrupt read must not silently re-enable a blocked workspace.
    expect(isInternetAccessEnabled("ws-protected")).toBe(false);
  });

  it("on a vanished file, keeps the last-known-good state instead of failing open", () => {
    // The app rewrites this file on every boot and the sidecar waits for it, so a file that
    // disappears is an anomaly — treating it as "nothing toggled off" would re-enable everyone.
    setInternetAccessPolicy("ws-survives-deletion", false);
    fs.rmSync(INTERNET_ACCESS_POLICY_FILE, { force: true });
    reloadInternetAccessPolicy();
    expect(isInternetAccessEnabled("ws-survives-deletion")).toBe(false);
  });
});
