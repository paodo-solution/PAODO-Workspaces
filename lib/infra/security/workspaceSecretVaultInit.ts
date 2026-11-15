// The vault-init job: creates the proxy's key pair and an empty vault on a first deployment, migrates a former
// vault, and refuses a vault whose recipient is not its private key. Idempotent; runs before app and proxy.
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { isLegacyVault, legacyKeyFileBeside, readLegacyVault } from "./legacyVaultV1";
import { generateRecipientKeyPair, recipientOf, seal } from "./secretSeal";
import {
  parseWorkspaceSecretVault,
  saveWorkspaceSecretVault,
  type VaultWorkspaceSecrets,
} from "./workspaceSecretVaultFormat";

export type VaultInitOutcome = "created" | "migrated" | "ready";

export interface VaultInitPaths {
  vaultFile: string;
  privateKeyFile: string;
}

export function readJsonOrNull(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function writePrivateKey(file: string, pem: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, pem, { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
}

// Generates a key only when no current-format vault depends on an existing one.
export function recipientFor(privateKeyFile: string): string {
  if (!existsSync(privateKeyFile)) {
    const pair = generateRecipientKeyPair();
    writePrivateKey(privateKeyFile, pair.privateKeyPem);
    return pair.recipient;
  }
  return recipientOf(readFileSync(privateKeyFile, "utf8"));
}

export function initWorkspaceSecretVault({ vaultFile, privateKeyFile }: VaultInitPaths): VaultInitOutcome {
  const legacyKeyFile = legacyKeyFileBeside(privateKeyFile);
  const parsed = readJsonOrNull(vaultFile);
  let outcome: VaultInitOutcome;

  if (parsed === null) {
    saveWorkspaceSecretVault({ version: 2, recipient: recipientFor(privateKeyFile), workspaceSecrets: {} }, vaultFile);
    outcome = "created";
  } else if (isLegacyVault(parsed)) {
    const legacy = readLegacyVault(parsed, legacyKeyFile);
    const recipient = recipientFor(privateKeyFile);
    const workspaceSecrets: VaultWorkspaceSecrets = {};
    for (const [wsId, secrets] of Object.entries(legacy)) {
      workspaceSecrets[wsId] = {};
      for (const [name, { value, createdAt, domains }] of Object.entries(secrets)) {
        const sealed = seal(value, recipient, { wsId, name, domains });
        workspaceSecrets[wsId][name] = { createdAt, domains, sealed };
      }
    }
    saveWorkspaceSecretVault({ version: 2, recipient, workspaceSecrets }, vaultFile);
    outcome = "migrated";
  } else {
    const vault = parseWorkspaceSecretVault(parsed);
    if (!existsSync(privateKeyFile)) {
      throw new Error(
        "workspace-secret private key is missing, so the vault cannot be opened: delete vault.json, run vault-init again, then re-enter the secrets",
      );
    }
    if (recipientOf(readFileSync(privateKeyFile, "utf8")) !== vault.recipient) {
      throw new Error("workspace-secret private key does not match the vault's recipient");
    }
    outcome = "ready";
  }

  // Only once the current-format vault is on disk, so a crash before this point leaves the former vault usable.
  if (existsSync(legacyKeyFile)) unlinkSync(legacyKeyFile);
  return outcome;
}
