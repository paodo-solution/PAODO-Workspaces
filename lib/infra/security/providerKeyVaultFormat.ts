// The provider-key vault file format, without state, so vault-init and llm-proxy can read it without loading
// the app's store. Each key is sealed to `recipient`, llm-proxy's public key; the app cannot open one.
import { readFileSync } from "fs";
import path from "path";
import { atomicSaveJson } from "../jsonPersist";
import { sealWith, type SealContext, type SealedValue } from "./secretSeal";
import { PROVIDER_VAULT_ROOT } from "./providerKeyPaths";

export const PROVIDER_VAULT_FILE = path.join(PROVIDER_VAULT_ROOT, "vault.json");

export interface VaultProviderKeyEntry {
  createdAt: string;
  /** The last few characters, kept readable so the app can show which key is loaded. */
  hint: string;
  sealed: SealedValue;
}

export type VaultProviderKeys = Record<string, VaultProviderKeyEntry>;

export interface ProviderVaultData {
  version: 2;
  /** llm-proxy's X25519 public key (SPKI DER, base64) every key is sealed to. */
  recipient: string;
  providerKeys: VaultProviderKeys;
}

// Enough to tell keys apart, too little to use; keys shorter than this can't be real, so show them whole.
const HINT_LENGTH = 4;

export function hintFor(value: string): string {
  return value.length <= HINT_LENGTH ? value : value.slice(-HINT_LENGTH);
}

/** Binds a sealed key to its provider, so a key moved to another provider's slot cannot be opened. */
export function providerKeyContext(provider: string): SealContext {
  return { info: Buffer.from("paodo-provider-key-v1"), aad: Buffer.from(`provider-v1\0${provider}`) };
}

export function sealProviderKey(value: string, recipient: string, provider: string): SealedValue {
  return sealWith(value, recipient, providerKeyContext(provider));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSealed(value: unknown): value is SealedValue {
  return isRecord(value) && ["epk", "iv", "tag", "data"].every((k) => typeof value[k] === "string");
}

/** Validates a parsed vault file; the former single-envelope format is reported as needing vault-init. */
export function parseProviderVault(value: unknown): ProviderVaultData {
  if (isRecord(value) && value.v === 1 && value.alg === "aes-256-gcm") {
    throw new Error("provider vault is in the former format — the vault-init job migrates it");
  }
  if (!isRecord(value) || value.version !== 2 || typeof value.recipient !== "string" || !value.recipient) {
    throw new Error("provider vault has an unsupported schema");
  }
  if (!isRecord(value.providerKeys)) throw new Error("provider vault has an unsupported schema");
  for (const [provider, raw] of Object.entries(value.providerKeys)) {
    if (
      !isRecord(raw) ||
      typeof raw.createdAt !== "string" ||
      !Number.isFinite(Date.parse(raw.createdAt)) ||
      typeof raw.hint !== "string" ||
      !isSealed(raw.sealed)
    ) {
      throw new Error(`provider key record ${provider} is malformed`);
    }
  }
  return value as unknown as ProviderVaultData;
}

export function readProviderVault(file: string = PROVIDER_VAULT_FILE): ProviderVaultData {
  return parseProviderVault(JSON.parse(readFileSync(file, "utf8")));
}

export function saveProviderVault(data: ProviderVaultData, file: string = PROVIDER_VAULT_FILE): void {
  atomicSaveJson(file, data);
}
