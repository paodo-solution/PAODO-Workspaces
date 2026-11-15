// vault-init must create llm-proxy's key pair on a first deployment, carry every former provider key over
// with a rollback copy, and stop the deploy rather than start on a vault and key that do not match.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPrivateKey, randomBytes } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { openWith } from "./secretOpen";
import { encryptWithKey } from "./vaultEncryption";
import { providerKeyContext, readProviderVault } from "./providerKeyVaultFormat";
import { initProviderKeyVault, legacyProviderFiles } from "./providerKeyVaultInit";

let dir: string;
let paths: { vaultFile: string; privateKeyFile: string };
let legacy: { keyFile: string; vaultCopy: string };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-vault-init-test-"));
  paths = { vaultFile: path.join(dir, "vault", "vault.json"), privateKeyFile: path.join(dir, "key", "private.pem") };
  legacy = legacyProviderFiles(paths.privateKeyFile);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function writeLegacyVault(providerKeys: unknown): string {
  const key = randomBytes(32);
  fs.mkdirSync(path.dirname(legacy.keyFile), { recursive: true });
  fs.writeFileSync(legacy.keyFile, key);
  fs.mkdirSync(path.dirname(paths.vaultFile), { recursive: true });
  const raw = JSON.stringify(encryptWithKey(JSON.stringify({ version: 1, providerKeys }), key));
  fs.writeFileSync(paths.vaultFile, raw);
  return raw;
}

function opened(): Record<string, string> {
  const vault = readProviderVault(paths.vaultFile);
  const key = createPrivateKey(fs.readFileSync(paths.privateKeyFile, "utf8"));
  return Object.fromEntries(
    Object.entries(vault.providerKeys).map(([provider, e]) => [provider, openWith(e.sealed, key, providerKeyContext(provider))]),
  );
}

describe("initProviderKeyVault", () => {
  it("creates a 0600 private key and an empty vault on a first deployment", () => {
    expect(initProviderKeyVault(paths)).toBe("created");
    expect(fs.statSync(paths.privateKeyFile).mode & 0o777).toBe(0o600);
    expect(readProviderVault(paths.vaultFile).providerKeys).toEqual({});
  });

  it("is a no-op on a re-run", () => {
    initProviderKeyVault(paths);
    const before = fs.readFileSync(paths.vaultFile, "utf8");
    expect(initProviderKeyVault(paths)).toBe("ready");
    expect(fs.readFileSync(paths.vaultFile, "utf8")).toBe(before);
  });

  it("migrates every former key with its date and hint, and keeps the former vault and key for rollback", () => {
    const former = writeLegacyVault({
      anthropic: { value: "sk-ant-abcd1234", createdAt: "2026-01-01T00:00:00.000Z" },
      openai: { value: "sk-openai-wxyz", createdAt: "2026-02-01T00:00:00.000Z" },
    });

    expect(initProviderKeyVault(paths)).toBe("migrated");
    expect(opened()).toEqual({ anthropic: "sk-ant-abcd1234", openai: "sk-openai-wxyz" });
    const vault = readProviderVault(paths.vaultFile);
    expect(vault.providerKeys.anthropic).toMatchObject({ createdAt: "2026-01-01T00:00:00.000Z", hint: "1234" });
    expect(fs.readFileSync(paths.vaultFile, "utf8")).not.toContain("sk-ant-abcd1234");
    expect(fs.readFileSync(legacy.vaultCopy, "utf8")).toBe(former);
    expect(fs.existsSync(legacy.keyFile)).toBe(true);
    expect(initProviderKeyVault(paths)).toBe("ready");
  });

  it("leaves a former vault untouched, and creates no key, when its former key is missing", () => {
    writeLegacyVault({ anthropic: { value: "v", createdAt: "2026-01-01T00:00:00.000Z" } });
    fs.rmSync(legacy.keyFile);
    const before = fs.readFileSync(paths.vaultFile, "utf8");

    expect(() => initProviderKeyVault(paths)).toThrow(/master\.key/);
    expect(fs.readFileSync(paths.vaultFile, "utf8")).toBe(before);
    expect(fs.existsSync(paths.privateKeyFile)).toBe(false);
  });

  it("refuses a vault sealed to another key", () => {
    initProviderKeyVault(paths);
    fs.rmSync(paths.privateKeyFile);
    initProviderKeyVault({ ...paths, vaultFile: path.join(dir, "other", "vault.json") });
    expect(() => initProviderKeyVault(paths)).toThrow(/does not match/);
  });

  it("refuses a current vault whose private key is gone, instead of generating a new one", () => {
    initProviderKeyVault(paths);
    fs.rmSync(paths.privateKeyFile);
    expect(() => initProviderKeyVault(paths)).toThrow(/missing/);
    expect(fs.existsSync(paths.privateKeyFile)).toBe(false);
  });
});
