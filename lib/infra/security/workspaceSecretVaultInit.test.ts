// vault-init must create a usable pair on a first deployment, carry every former secret over, and stop the
// deploy rather than start the app and proxy on a vault and key that do not match.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrivateKey, randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { openSealed } from "./secretOpen";
import { encryptWithKey } from "./vaultEncryption";
import { readWorkspaceSecretVault } from "./workspaceSecretVaultFormat";
import { initWorkspaceSecretVault } from "./workspaceSecretVaultInit";

let dir: string;
let paths: { vaultFile: string; privateKeyFile: string };
let legacyKeyFile: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-init-test-"));
  paths = { vaultFile: path.join(dir, "vault", "vault.json"), privateKeyFile: path.join(dir, "key", "private.pem") };
  legacyKeyFile = path.join(dir, "key", "master.key");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeLegacyVault(workspaceSecrets: unknown): void {
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(legacyKeyFile), { recursive: true });
  fs.writeFileSync(legacyKeyFile, key);
  fs.mkdirSync(path.dirname(paths.vaultFile), { recursive: true });
  const envelope = encryptWithKey(JSON.stringify({ version: 1, workspaceSecrets }), key);
  fs.writeFileSync(paths.vaultFile, JSON.stringify(envelope));
}

function opened(): Record<string, Record<string, string>> {
  const vault = readWorkspaceSecretVault(paths.vaultFile);
  const key = createPrivateKey(fs.readFileSync(paths.privateKeyFile, "utf8"));
  const out: Record<string, Record<string, string>> = {};
  for (const [wsId, secrets] of Object.entries(vault.workspaceSecrets)) {
    out[wsId] = {};
    for (const [name, e] of Object.entries(secrets))
      out[wsId][name] = openSealed(e.sealed, key, { wsId, name, domains: e.domains });
  }
  return out;
}

describe("initWorkspaceSecretVault", () => {
  it("creates a 0600 private key and an empty vault on a first deployment", () => {
    expect(initWorkspaceSecretVault(paths)).toBe("created");
    expect(fs.statSync(paths.privateKeyFile).mode & 0o777).toBe(0o600);
    expect(readWorkspaceSecretVault(paths.vaultFile).workspaceSecrets).toEqual({});
  });

  it("is a no-op on a re-run", () => {
    initWorkspaceSecretVault(paths);
    const before = fs.readFileSync(paths.vaultFile, "utf8");
    expect(initWorkspaceSecretVault(paths)).toBe("ready");
    expect(fs.readFileSync(paths.vaultFile, "utf8")).toBe(before);
  });

  it("migrates every former secret, keeps its metadata, and deletes the former key", () => {
    writeLegacyVault({
      ws1: { GITHUB_TOKEN: { value: "ghp_1", createdAt: "2026-01-01T00:00:00.000Z", domains: ["github.com"] } },
      ws2: { CRM_TOKEN: { value: "crm_2", createdAt: "2026-02-01T00:00:00.000Z", domains: ["api.crm.example"] } },
    });

    expect(initWorkspaceSecretVault(paths)).toBe("migrated");
    expect(opened()).toEqual({ ws1: { GITHUB_TOKEN: "ghp_1" }, ws2: { CRM_TOKEN: "crm_2" } });
    const vault = readWorkspaceSecretVault(paths.vaultFile);
    expect(vault.workspaceSecrets.ws1.GITHUB_TOKEN.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(fs.readFileSync(paths.vaultFile, "utf8")).not.toContain("ghp_1");
    expect(fs.existsSync(legacyKeyFile)).toBe(false);
    expect(initWorkspaceSecretVault(paths)).toBe("ready");
  });

  it("leaves a former vault untouched, and creates no key, when its former key is missing", () => {
    writeLegacyVault({ ws1: { K: { value: "v", createdAt: "2026-01-01T00:00:00.000Z", domains: ["a.example"] } } });
    fs.rmSync(legacyKeyFile);
    const before = fs.readFileSync(paths.vaultFile, "utf8");

    expect(() => initWorkspaceSecretVault(paths)).toThrow();
    expect(fs.readFileSync(paths.vaultFile, "utf8")).toBe(before);
    expect(fs.existsSync(paths.privateKeyFile)).toBe(false);
  });

  it("refuses a vault sealed to another key", () => {
    initWorkspaceSecretVault(paths);
    fs.rmSync(paths.privateKeyFile);
    initWorkspaceSecretVault({ ...paths, vaultFile: path.join(dir, "other", "vault.json") });
    expect(() => initWorkspaceSecretVault(paths)).toThrow(/does not match/);
  });

  it("refuses a current vault whose private key is gone, instead of generating a new one", () => {
    initWorkspaceSecretVault(paths);
    fs.rmSync(paths.privateKeyFile);
    expect(() => initWorkspaceSecretVault(paths)).toThrow(/missing/);
    expect(fs.existsSync(paths.privateKeyFile)).toBe(false);
  });
});
