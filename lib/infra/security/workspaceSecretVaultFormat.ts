// The workspace-secret vault file format, without state, so vault-init can read and write it without loading
// the live store. Each value is sealed to `recipient`, the proxy's public key.
import { readFileSync } from "fs";
import path from "path";
import { atomicSaveJson } from "../jsonPersist";
import type { SealedValue } from "./secretSeal";
import { WORKSPACE_SECRET_VAULT_ROOT } from "./workspaceSecretPaths";

export const WORKSPACE_SECRET_VAULT_FILE = path.join(WORKSPACE_SECRET_VAULT_ROOT, "vault.json");

export interface VaultWorkspaceSecretEntry {
  createdAt: string;
  domains: string[];
  sealed: SealedValue;
}

export type VaultWorkspaceSecrets = Record<string, Record<string, VaultWorkspaceSecretEntry>>;

export interface WorkspaceSecretVaultData {
  version: 2;
  /** The proxy's X25519 public key (SPKI DER, base64) every value is sealed to. */
  recipient: string;
  workspaceSecrets: VaultWorkspaceSecrets;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSealed(value: unknown): value is SealedValue {
  return isRecord(value) && ["epk", "iv", "tag", "data"].every((k) => typeof value[k] === "string");
}

/** Validates a parsed vault file; the former single-envelope format is reported as needing vault-init. */
export function parseWorkspaceSecretVault(value: unknown): WorkspaceSecretVaultData {
  if (isRecord(value) && value.v === 1 && value.alg === "aes-256-gcm") {
    throw new Error("workspace-secret vault is in the former format — the vault-init job migrates it");
  }
  if (!isRecord(value) || value.version !== 2 || typeof value.recipient !== "string" || !value.recipient) {
    throw new Error("workspace-secret vault has an unsupported schema");
  }
  if (!isRecord(value.workspaceSecrets)) throw new Error("workspace-secret vault has an unsupported schema");
  for (const [workspaceId, rawWorkspace] of Object.entries(value.workspaceSecrets)) {
    if (!isRecord(rawWorkspace)) throw new Error(`workspace secret namespace ${workspaceId} is malformed`);
    for (const [name, raw] of Object.entries(rawWorkspace)) {
      if (
        !isRecord(raw) ||
        typeof raw.createdAt !== "string" ||
        !Number.isFinite(Date.parse(raw.createdAt)) ||
        !Array.isArray(raw.domains) ||
        !raw.domains.every((domain) => typeof domain === "string") ||
        !isSealed(raw.sealed)
      ) {
        throw new Error(`workspace secret record ${workspaceId}/${name} is malformed`);
      }
    }
  }
  return value as unknown as WorkspaceSecretVaultData;
}

export function readWorkspaceSecretVault(file: string = WORKSPACE_SECRET_VAULT_FILE): WorkspaceSecretVaultData {
  return parseWorkspaceSecretVault(JSON.parse(readFileSync(file, "utf8")));
}

export function saveWorkspaceSecretVault(data: WorkspaceSecretVaultData, file: string = WORKSPACE_SECRET_VAULT_FILE) {
  atomicSaveJson(file, data);
}
