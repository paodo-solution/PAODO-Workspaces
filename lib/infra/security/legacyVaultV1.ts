// TODO(remove after 2027-05-31): reads the former single-key vault so vault-init can migrate it. Only
// vault-init may import this (ESLint); deployments must upgrade through the release that ships it.
import { readFileSync } from "fs";
import path from "path";
import { decryptWithKey, isEncEnvelope } from "./vaultEncryption";

export interface LegacySecret {
  value: string;
  createdAt: string;
  domains: string[];
}

/** The former AES key sat beside the new private key, in the same volume. */
export function legacyKeyFileBeside(privateKeyFile: string): string {
  return path.join(path.dirname(privateKeyFile), "master.key");
}

export function isLegacyVault(parsed: unknown): boolean {
  return isEncEnvelope(parsed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decrypts a former vault with its key; throws on a wrong key, tampering or a malformed record. */
export function readLegacyVault(parsed: unknown, keyFile: string): Record<string, Record<string, LegacySecret>> {
  if (!isEncEnvelope(parsed)) throw new Error("not a former-format workspace-secret vault");
  const key = readFileSync(keyFile);
  if (key.length !== 32) throw new Error("former workspace-secret key is corrupt (expected 32 bytes)");
  const data: unknown = JSON.parse(decryptWithKey(parsed, key));
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.workspaceSecrets)) {
    throw new Error("former workspace-secret vault has an unsupported schema");
  }
  for (const [wsId, ws] of Object.entries(data.workspaceSecrets)) {
    if (!isRecord(ws)) throw new Error(`former workspace secret namespace ${wsId} is malformed`);
    for (const [name, raw] of Object.entries(ws)) {
      const ok =
        isRecord(raw) &&
        typeof raw.value === "string" &&
        typeof raw.createdAt === "string" &&
        Array.isArray(raw.domains) &&
        raw.domains.every((d) => typeof d === "string");
      if (!ok) throw new Error(`former workspace secret record ${wsId}/${name} is malformed`);
    }
  }
  return data.workspaceSecrets as Record<string, Record<string, LegacySecret>>;
}
