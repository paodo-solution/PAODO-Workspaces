// A reload must pick up a vault-init re-run without a restart, refuse a vault its private key cannot open, and
// clear every key while the vault is unreadable.
import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";

const VAULT_FILE = path.join(process.env.PAODO_PROVIDER_VAULT_ROOT!, "vault.json");
const KEY_FILE = process.env.PAODO_PROVIDER_PRIVATE_KEY_FILE!;

async function fresh() {
  delete (global as Record<string, unknown>)._providerKeyVaultState;
  vi.resetModules();
  const { initProviderKeyVault } = await import("../security/providerKeyVaultInit");
  fs.rmSync(VAULT_FILE, { force: true });
  fs.rmSync(KEY_FILE, { force: true });
  initProviderKeyVault({ vaultFile: VAULT_FILE, privateKeyFile: KEY_FILE });
  delete (global as Record<string, unknown>)._providerKeyVaultState;
  vi.resetModules();
  const store = await import("../security/providerKeyStore");
  const ring = await import("./providerKeyRing");
  ring.loadProviderPrivateKey();
  ring.rebuildProviderKeyRing();
  return { store, ring, initProviderKeyVault };
}

beforeEach(() => vi.restoreAllMocks());

describe("reloadProviderKeyRing", () => {
  it("picks up a new key written by the app", async () => {
    const { store, ring } = await fresh();
    store.setProviderKey("openai", "sk-new");
    expect(ring.reloadProviderKeyRing()).toBe(1);
    expect(ring.providerApiKey("openai")).toBe("sk-new");
  });

  it("picks up a vault-init re-run that made a new key pair, without a restart", async () => {
    const { ring, initProviderKeyVault } = await fresh();
    fs.rmSync(VAULT_FILE);
    fs.rmSync(KEY_FILE);
    initProviderKeyVault({ vaultFile: VAULT_FILE, privateKeyFile: KEY_FILE });
    const { sealProviderKey, readProviderVault, saveProviderVault } = await import(
      "../security/providerKeyVaultFormat"
    );
    const vault = readProviderVault(VAULT_FILE);
    vault.providerKeys.openai = {
      createdAt: new Date().toISOString(),
      hint: "-new",
      sealed: sealProviderKey("sk-after-reset", vault.recipient, "openai"),
    };
    saveProviderVault(vault, VAULT_FILE);

    expect(ring.reloadProviderKeyRing()).toBe(1);
    expect(ring.providerApiKey("openai")).toBe("sk-after-reset");
  });

  it("throws when the vault is sealed to a key other than the mounted one", async () => {
    const { ring, initProviderKeyVault } = await fresh();
    const other = path.join(path.dirname(KEY_FILE), "other");
    initProviderKeyVault({ vaultFile: path.join(other, "vault.json"), privateKeyFile: path.join(other, "private.pem") });
    fs.copyFileSync(path.join(other, "vault.json"), VAULT_FILE);

    expect(() => ring.reloadProviderKeyRing()).toThrow(/does not match/);
  });

  it("clears every key while the vault is unreadable", async () => {
    const { store, ring } = await fresh();
    store.setProviderKey("openai", "sk-1");
    ring.reloadProviderKeyRing();
    fs.writeFileSync(VAULT_FILE, "{ not json");

    expect(ring.reloadProviderKeyRing()).toBe(0);
    expect(ring.providerApiKey("openai")).toBeUndefined();
  });
});
