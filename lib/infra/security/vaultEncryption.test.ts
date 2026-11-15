// The AES-GCM envelope behind the provider vault, the former workspace-secret vault and sealed secrets. Pins
// round-tripping, tamper detection, authenticated data, and key provisioning.
import { describe, it, expect, vi, afterAll } from "vitest";
import { randomBytes } from "crypto";
import fs from "fs";

const { ROOT, KEY_FILE } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-enc-test-"));
  const keyFile = path.join(root, "provider-key", "master.key");
  process.env.PAODO_PROVIDER_KEY_FILE = keyFile;
  delete (global as Record<string, unknown>)._vaultEncryptionKeys;
  return { ROOT: root, KEY_FILE: keyFile };
});

import { decryptWithKey, encryptWithKey, isEncEnvelope } from "./vaultEncryption";
import { getProviderVaultKey } from "./providerKeyEncryption";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const key = randomBytes(32);
const flip = (b64: string): string => {
  const buf = Buffer.from(b64, "base64");
  buf[0] ^= 0xff;
  return buf.toString("base64");
};

describe("encrypt/decrypt", () => {
  it("recovers the exact plaintext and never contains it", () => {
    const env = encryptWithKey("sk-secret-123", key);
    expect(JSON.stringify(env)).not.toContain("sk-secret-123");
    expect(decryptWithKey(env, key)).toBe("sk-secret-123");
  });

  it("uses a fresh IV per call", () => {
    expect(encryptWithKey("same", key).iv).not.toBe(encryptWithKey("same", key).iv);
  });

  it("throws when the ciphertext, tag or IV is modified, or the key is wrong", () => {
    const env = encryptWithKey("payload", key);
    for (const field of ["data", "tag", "iv"] as const) {
      expect(() => decryptWithKey({ ...env, [field]: flip(env[field]) }, key)).toThrow();
    }
    expect(() => decryptWithKey(env, randomBytes(32))).toThrow();
  });

  it("requires the same authenticated data it was encrypted with", () => {
    const env = encryptWithKey("payload", key, Buffer.from("ws1"));
    expect(decryptWithKey(env, key, Buffer.from("ws1"))).toBe("payload");
    expect(() => decryptWithKey(env, key, Buffer.from("ws2"))).toThrow();
    expect(() => decryptWithKey(env, key)).toThrow();
  });
});

describe("isEncEnvelope", () => {
  it("accepts a real envelope and rejects near-misses", () => {
    expect(isEncEnvelope(encryptWithKey("x", key))).toBe(true);
    expect(isEncEnvelope(null)).toBe(false);
    expect(isEncEnvelope([])).toBe(false);
    expect(isEncEnvelope({ v: 2, alg: "aes-256-gcm", iv: "a", tag: "b", data: "c" })).toBe(false);
    expect(isEncEnvelope({ v: 1, alg: "aes-256-cbc", iv: "a", tag: "b", data: "c" })).toBe(false);
  });
});

describe("key provisioning", () => {
  it("creates a 32-byte key file with mode 0600 and returns it stably", () => {
    const k = getProviderVaultKey();
    expect(k.length).toBe(32);
    expect(getProviderVaultKey()).toBe(k);
    expect(fs.statSync(KEY_FILE).mode & 0o777).toBe(0o600);
  });

  it("does not replace an existing key after a non-ENOENT read failure", () => {
    getProviderVaultKey();
    const original = fs.readFileSync(KEY_FILE);
    delete (global as Record<string, unknown>)._vaultEncryptionKeys;
    const read = vi.spyOn(fs, "readFileSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("simulated storage failure"), { code: "EIO" });
    });

    expect(() => getProviderVaultKey()).toThrow("simulated storage failure");
    read.mockRestore();
    expect(fs.readFileSync(KEY_FILE).equals(original)).toBe(true);
  });
});
