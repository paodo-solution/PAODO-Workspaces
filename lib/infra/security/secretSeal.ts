// Seals a value to an X25519 public key, so the app can store what it can never read back. Workspace secrets
// seal to credproxy, provider keys to llm-proxy; opening lives in secretOpen.ts, banned in the app.
import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "crypto";
import { encryptWithKey } from "./vaultEncryption";

export interface SealedValue {
  /** The ephemeral X25519 public key (SPKI DER, base64) the value was sealed with. */
  epk: string;
  iv: string;
  tag: string;
  data: string;
}

/** What a sealed value is bound to. Moving it to another workspace, name or domain makes it unopenable. */
export interface SecretBinding {
  wsId: string;
  name: string;
  domains: string[];
}

const WORKSPACE_SECRET_INFO = Buffer.from("paodo-workspace-secret-v2");

export function bindingBytes(binding: SecretBinding): Buffer {
  return Buffer.from(["v2", binding.wsId, binding.name, [...binding.domains].sort().join(",")].join("\0"));
}

/** What a value is sealed for: `info` separates key uses, `aad` binds the value to where it is stored. */
export interface SealContext {
  info: Buffer;
  aad: Buffer;
}

export function workspaceSecretContext(binding: SecretBinding): SealContext {
  return { info: WORKSPACE_SECRET_INFO, aad: bindingBytes(binding) };
}

export function sealingKey(shared: Buffer, epk: Buffer, recipient: Buffer, info: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epk, recipient]), info, 32));
}

function spki(key: KeyObject): Buffer {
  return key.export({ format: "der", type: "spki" });
}

/** A new key pair: the base64 SPKI public key for the vault, the PKCS#8 PEM private key for the proxy. */
export function generateRecipientKeyPair(): { recipient: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    recipient: spki(publicKey).toString("base64"),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

/** The base64 SPKI public key matching a PEM private key; throws on anything but X25519. */
export function recipientOf(privateKeyPem: string): string {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "x25519") throw new Error("vault private key is not an X25519 key");
  return spki(createPublicKey(privateKey)).toString("base64");
}

export function sealWith(value: string, recipient: string, context: SealContext): SealedValue {
  const recipientDer = Buffer.from(recipient, "base64");
  const recipientKey = createPublicKey({ key: recipientDer, format: "der", type: "spki" });
  const ephemeral = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey });
  const epk = spki(ephemeral.publicKey);
  const envelope = encryptWithKey(value, sealingKey(shared, epk, recipientDer, context.info), context.aad);
  return { epk: epk.toString("base64"), iv: envelope.iv, tag: envelope.tag, data: envelope.data };
}

export function seal(value: string, recipient: string, binding: SecretBinding): SealedValue {
  return sealWith(value, recipient, workspaceSecretContext(binding));
}
