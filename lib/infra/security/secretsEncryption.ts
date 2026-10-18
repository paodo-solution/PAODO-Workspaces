// AES-256-GCM for workspace secrets (recoverable, since the proxy injects them). The 0600 key lives on its own
// mount, so a data or vault backup alone exposes nothing; cached on `global`.
import { WORKSPACE_SECRET_VAULT_KEY_FILE } from "./workspaceSecretPaths";
import { decryptWithKey, encryptWithKey, getVaultKey, isEncEnvelope, type EncEnvelope } from "./vaultEncryption";

export { isEncEnvelope, type EncEnvelope };

export function getSecretsEncKey(): Buffer {
  return getVaultKey(WORKSPACE_SECRET_VAULT_KEY_FILE, "workspace-secrets", "workspaceSecretEncryption");
}

export function encryptToEnvelope(plaintext: string): EncEnvelope {
  return encryptWithKey(plaintext, getSecretsEncKey());
}

// Throws on any tamper (GCM auth failure), wrong key, or malformed envelope — callers fail closed.
export function decryptFromEnvelope(env: EncEnvelope): string {
  return decryptWithKey(env, getSecretsEncKey());
}
