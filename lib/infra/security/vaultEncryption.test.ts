// The AES-GCM envelope behind sealed values and the former single-key vaults. Pins round-tripping, tamper
// detection and authenticated data.
import { describe, it, expect } from "vitest";
import { randomBytes } from "crypto";

import { decryptWithKey, encryptWithKey, isEncEnvelope } from "./vaultEncryption";

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
