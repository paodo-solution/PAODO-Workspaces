// Opens a sealed workspace secret. Needs the private key, which only credproxy and vault-init mount; the
// ESLint config bans importing this module from anywhere else.
import { createPublicKey, diffieHellman, type KeyObject } from "crypto";
import { bindingBytes, sealingKey, type SealedValue, type SecretBinding } from "./secretSeal";
import { decryptWithKey } from "./vaultEncryption";

/** Throws on a wrong key, a tampered value, or a binding that differs from the one it was sealed with. */
export function openSealed(sealed: SealedValue, privateKey: KeyObject, binding: SecretBinding): string {
  const epk = Buffer.from(sealed.epk, "base64");
  const ephemeral = createPublicKey({ key: epk, format: "der", type: "spki" });
  const shared = diffieHellman({ privateKey, publicKey: ephemeral });
  const recipient = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const envelope = { v: 1, alg: "aes-256-gcm", iv: sealed.iv, tag: sealed.tag, data: sealed.data } as const;
  return decryptWithKey(envelope, sealingKey(shared, epk, recipient), bindingBytes(binding));
}
