// The vault-init step for provider keys: creates llm-proxy's key pair and an empty vault, migrates the former
// AES vault once, and refuses a vault whose recipient is not its private key. Only vault-init may import this.
import { copyFileSync, existsSync, readFileSync } from "fs";
import path from "path";
import { recipientOf } from "./secretSeal";
import { decryptWithKey, isEncEnvelope } from "./vaultEncryption";
import {
  hintFor,
  parseProviderVault,
  saveProviderVault,
  sealProviderKey,
  type VaultProviderKeys,
} from "./providerKeyVaultFormat";
import { readJsonOrNull, recipientFor, type VaultInitOutcome, type VaultInitPaths } from "./workspaceSecretVaultInit";

/** The former AES key and the rollback copy of the former vault, both beside the private key. */
export function legacyProviderFiles(privateKeyFile: string): { keyFile: string; vaultCopy: string } {
  const dir = path.dirname(privateKeyFile);
  return { keyFile: path.join(dir, "master.key"), vaultCopy: path.join(dir, "vault.v1.json") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readLegacyProviderKeys(parsed: unknown, keyFile: string): Record<string, { value: string; createdAt: string }> {
  if (!isEncEnvelope(parsed)) throw new Error("not a former-format provider vault");
  if (!existsSync(keyFile)) {
    throw new Error(
      "former provider vault has no master.key beside it, so it cannot be migrated: delete vault.json, run vault-init again, then re-enter the keys",
    );
  }
  const key = readFileSync(keyFile);
  if (key.length !== 32) throw new Error("former provider key is corrupt (expected 32 bytes)");
  const data: unknown = JSON.parse(decryptWithKey(parsed, key));
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.providerKeys)) {
    throw new Error("former provider vault has an unsupported schema");
  }
  for (const [provider, raw] of Object.entries(data.providerKeys)) {
    if (!isRecord(raw) || typeof raw.value !== "string" || typeof raw.createdAt !== "string") {
      throw new Error(`former provider key record ${provider} is malformed`);
    }
  }
  return data.providerKeys as Record<string, { value: string; createdAt: string }>;
}

export function initProviderKeyVault({ vaultFile, privateKeyFile }: VaultInitPaths): VaultInitOutcome {
  const parsed = readJsonOrNull(vaultFile);

  if (parsed === null) {
    saveProviderVault({ version: 2, recipient: recipientFor(privateKeyFile), providerKeys: {} }, vaultFile);
    return "created";
  }

  if (isEncEnvelope(parsed)) {
    const legacy = legacyProviderFiles(privateKeyFile);
    const keys = readLegacyProviderKeys(parsed, legacy.keyFile);
    const recipient = recipientFor(privateKeyFile);
    const providerKeys: VaultProviderKeys = {};
    for (const [provider, { value, createdAt }] of Object.entries(keys)) {
      providerKeys[provider] = { createdAt, hint: hintFor(value), sealed: sealProviderKey(value, recipient, provider) };
    }
    // The rollback copy goes beside master.key, a volume the app no longer mounts; both stay until removed by hand.
    if (!existsSync(legacy.vaultCopy)) copyFileSync(vaultFile, legacy.vaultCopy);
    saveProviderVault({ version: 2, recipient, providerKeys }, vaultFile);
    return "migrated";
  }

  const vault = parseProviderVault(parsed);
  if (!existsSync(privateKeyFile)) {
    throw new Error(
      "provider private key is missing, so the vault cannot be opened: delete vault.json, run vault-init again, then re-enter the keys",
    );
  }
  if (recipientOf(readFileSync(privateKeyFile, "utf8")) !== vault.recipient) {
    throw new Error("provider private key does not match the vault's recipient");
  }
  return "ready";
}
