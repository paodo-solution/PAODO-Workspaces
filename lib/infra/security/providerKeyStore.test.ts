// The only copy of the keys the deployment spends with. The app seals them to llm-proxy and can never read one
// back; an unreadable store is never replaced by an empty one, which the next save would make permanent.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync, writeFileSync, rmSync, existsSync } from "fs";

// vi.mock is hoisted above the imports, so the temp root has to be created in a hoisted block too.
const { ROOT, VAULT_FILE, KEY_FILE } = vi.hoisted(() => {
  const { mkdtempSync } = require("fs") as typeof import("fs");
  const { tmpdir } = require("os") as typeof import("os");
  const { join } = require("path") as typeof import("path");
  const root = mkdtempSync(join(tmpdir(), "provider-keys-"));
  process.env.PAODO_PROVIDER_VAULT_ROOT = join(root, "provider-vault");
  process.env.PAODO_PROVIDER_PRIVATE_KEY_FILE = join(root, "provider-key", "private.pem");
  delete (global as Record<string, unknown>)._providerKeyVaultState;
  return {
    ROOT: root,
    VAULT_FILE: join(root, "provider-vault", "vault.json"),
    KEY_FILE: join(root, "provider-key", "private.pem"),
  };
});

import { initProviderKeyVault } from "./providerKeyVaultInit";

// The store loads from disk once at import and caches on global, so each case re-imports a fresh one.
async function freshStore() {
  delete (global as Record<string, unknown>)._providerKeyVaultState;
  vi.resetModules();
  return import("./providerKeyStore");
}

// llm-proxy's view: the same vault, opened with the private key.
async function proxyKey(provider: string): Promise<string | undefined> {
  const ring = await import("../llmProxy/providerKeyRing");
  ring.loadProviderPrivateKey();
  ring.rebuildProviderKeyRing();
  return ring.providerApiKey(provider);
}

beforeEach(() => {
  rmSync(VAULT_FILE, { force: true });
  rmSync(KEY_FILE, { force: true });
  initProviderKeyVault({ vaultFile: VAULT_FILE, privateKeyFile: KEY_FILE });
});

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe("provider key round-trip", () => {
  it("stores a key that only llm-proxy can open", async () => {
    const store = await freshStore();
    store.setProviderKey("anthropic", "sk-ant-secret-value");
    expect(store.hasProviderKey("anthropic")).toBe(true);
    expect(await proxyKey("anthropic")).toBe("sk-ant-secret-value");
  });

  it("reports no key for a provider that never had one", async () => {
    const store = await freshStore();
    expect(store.hasProviderKey("openai")).toBe(false);
    expect(await proxyKey("openai")).toBeUndefined();
  });

  it("replaces in place rather than accumulating versions", async () => {
    const store = await freshStore();
    store.setProviderKey("openai", "first");
    store.setProviderKey("openai", "second");
    expect(await proxyKey("openai")).toBe("second");
    expect(store.listProviderKeyMeta()).toHaveLength(1);
  });

  it("deletes, and reports whether there was anything to delete", async () => {
    const store = await freshStore();
    store.setProviderKey("mistral", "key");
    expect(store.deleteProviderKey("mistral")).toBe(true);
    expect(store.deleteProviderKey("mistral")).toBe(false);
    expect(store.hasProviderKey("mistral")).toBe(false);
  });
});

describe("what leaves the module", () => {
  it("never puts a value in the metadata", async () => {
    const store = await freshStore();
    store.setProviderKey("anthropic", "sk-ant-the-actual-secret");
    const [meta] = store.listProviderKeyMeta();
    // Asserting on the serialized shape, not on named fields: a field added later that happens to
    // carry the value would pass a key-by-key check and fail this one.
    expect(JSON.stringify(meta)).not.toContain("sk-ant-the-actual-secret");
    expect(meta).toEqual({ provider: "anthropic", createdAt: expect.any(String), hint: "cret" });
  });

  it("shows a short value whole rather than hiding a typo", async () => {
    // A value this short cannot be a real key, and masking it only makes the mistake harder to see.
    const store = await freshStore();
    store.setProviderKey("openai", "abc");
    expect(store.listProviderKeyMeta()[0].hint).toBe("abc");
  });

  it("exports no way to read a key back", async () => {
    const store = await freshStore();
    expect(Object.keys(store)).not.toContain("getProviderKey");
  });
});

describe("sealing at rest", () => {
  it("writes no key material readable in the file", async () => {
    const store = await freshStore();
    store.setProviderKey("deepseek", "sk-plaintext-would-be-a-leak");

    const raw = readFileSync(VAULT_FILE, "utf8");
    expect(raw).not.toContain("sk-plaintext-would-be-a-leak");
    expect(JSON.parse(raw)).toMatchObject({ version: 2, recipient: expect.any(String) });
  });

  it("binds each key to its provider, so a key moved to another slot cannot be opened", async () => {
    const store = await freshStore();
    store.setProviderKey("openai", "sk-openai");
    const vault = JSON.parse(readFileSync(VAULT_FILE, "utf8"));
    vault.providerKeys.deepseek = vault.providerKeys.openai;
    writeFileSync(VAULT_FILE, JSON.stringify(vault));

    await freshStore();
    expect(await proxyKey("deepseek")).toBeUndefined();
    expect(await proxyKey("openai")).toBe("sk-openai");
  });
});

describe("purgeProviderKeysExcept", () => {
  it("deletes exactly the providers not allowed, and names them", async () => {
    const store = await freshStore();
    store.setProviderKey("anthropic", "a");
    store.setProviderKey("openai", "o");
    store.setProviderKey("mistral", "m");

    expect(store.purgeProviderKeysExcept(["anthropic", "mistral"])).toEqual(["openai"]);

    expect(store.hasProviderKey("openai")).toBe(false);
    expect(await proxyKey("anthropic")).toBe("a");
    expect(await proxyKey("mistral")).toBe("m");
  });

  it("purges a provider that has left the registry entirely, not just one switched off", async () => {
    const store = await freshStore();
    store.setProviderKey("retired-vendor", "k");
    expect(store.purgeProviderKeysExcept(["anthropic"])).toEqual(["retired-vendor"]);
  });

  it("does nothing, and writes nothing, when every stored provider is still allowed", async () => {
    const store = await freshStore();
    store.setProviderKey("anthropic", "a");
    rmSync(VAULT_FILE, { force: true });

    expect(store.purgeProviderKeysExcept(["anthropic", "openai"])).toEqual([]);
    // No save on a no-op: an unnecessary write is a chance to fail while destroying nothing.
    expect(existsSync(VAULT_FILE)).toBe(false);
  });
});

describe("a store that cannot be read", () => {
  it("starts empty but refuses to let startup continue", async () => {
    // Valid JSON in no known shape — what a partial write or a hand-edit leaves behind.
    writeFileSync(VAULT_FILE, JSON.stringify({ anthropic: { value: "k" } }));

    const store = await freshStore();

    // Empty in memory is survivable; serving requests from it is not, because the first save would
    // overwrite the unreadable file and destroy whatever it really held.
    expect(store.hasProviderKey("anthropic")).toBe(false);
    expect(() => store.assertProviderKeyStoreAvailable()).toThrow();
    expect(() => store.setProviderKey("anthropic", "k")).toThrow(/unavailable/);
  });

  it("refuses to start without the vault vault-init creates", async () => {
    rmSync(VAULT_FILE, { force: true });

    const store = await freshStore();

    expect(store.listProviderKeyMeta()).toEqual([]);
    expect(() => store.assertProviderKeyStoreAvailable()).toThrow(/vault-init/);
  });

  it("reads back keys written by an earlier process", async () => {
    (await freshStore()).setProviderKey("anthropic", "survives-a-restart");

    const store = await freshStore();

    expect(store.listProviderKeyMeta()).toEqual([
      { provider: "anthropic", createdAt: expect.any(String), hint: "tart" },
    ]);
    expect(() => store.assertProviderKeyStoreAvailable()).not.toThrow();
  });
});
