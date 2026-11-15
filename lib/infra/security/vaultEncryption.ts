// Shared AES-256-GCM envelope mechanics, behind sealed values and the former single-key vaults that
// vault-init migrates.
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export interface EncEnvelope {
  v: 1;
  alg: "aes-256-gcm";
  iv: string;
  tag: string;
  data: string;
}

export function isEncEnvelope(value: unknown): value is EncEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as Record<string, unknown>;
  return (
    envelope.v === 1 &&
    envelope.alg === "aes-256-gcm" &&
    typeof envelope.iv === "string" &&
    typeof envelope.tag === "string" &&
    typeof envelope.data === "string"
  );
}

// `aad` is authenticated but not encrypted: decryption fails unless the caller presents the same bytes.
export function encryptWithKey(plaintext: string, key: Buffer, aad?: Buffer): EncEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  if (aad) cipher.setAAD(aad);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}

export function decryptWithKey(envelope: EncEnvelope, key: Buffer, aad?: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8");
}
