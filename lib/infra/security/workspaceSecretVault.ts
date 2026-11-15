// Live store for proxy-injected secrets. Values are sealed to the proxy's public key, so the app reads and
// writes this vault without any key; vault-init creates it and migrates the former format.
import { createLogger } from "../logger";
import {
  WORKSPACE_SECRET_VAULT_FILE,
  readWorkspaceSecretVault,
  saveWorkspaceSecretVault,
  type VaultWorkspaceSecrets,
} from "./workspaceSecretVaultFormat";

export {
  WORKSPACE_SECRET_VAULT_FILE,
  type VaultWorkspaceSecretEntry,
  type VaultWorkspaceSecrets,
} from "./workspaceSecretVaultFormat";

const log = createLogger("workspaceSecretVault");

interface WorkspaceSecretVaultState {
  recipient: string | null;
  workspaceSecrets: VaultWorkspaceSecrets;
  loadError: unknown;
}

// A missing vault is an error too: vault-init always creates one before the app or the proxy starts.
function load(): WorkspaceSecretVaultState {
  try {
    const data = readWorkspaceSecretVault();
    return { recipient: data.recipient, workspaceSecrets: data.workspaceSecrets, loadError: null };
  } catch (err) {
    log.error(
      {
        event: "workspace_secret_vault_load_failed",
        outcome: "empty_vault_used",
        err,
        filePath: WORKSPACE_SECRET_VAULT_FILE,
      },
      "failed to load workspace-secret vault — starting empty",
    );
    return { recipient: null, workspaceSecrets: {}, loadError: err };
  }
}

const g = global as typeof global & { _workspaceSecretVaultState?: WorkspaceSecretVaultState };
g._workspaceSecretVaultState ??= load();
const state = g._workspaceSecretVaultState;

function replaceRecord(target: VaultWorkspaceSecrets, next: VaultWorkspaceSecrets): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

export function assertWorkspaceSecretVaultAvailable(): void {
  if (state.loadError) throw state.loadError;
}

export function workspaceSecretRecords(): VaultWorkspaceSecrets {
  return state.workspaceSecrets;
}

/** The key new values are sealed to. Throws while the vault is unavailable, so nothing is sealed to nothing. */
export function workspaceSecretRecipient(): string {
  if (!state.recipient) throw new Error("workspace-secret vault is unavailable — new secrets cannot be stored");
  return state.recipient;
}

/** Persist first, then publish the new state so failed writes never create memory-only secrets. */
export function commitWorkspaceSecrets(next: VaultWorkspaceSecrets, context: Record<string, unknown>): void {
  try {
    saveWorkspaceSecretVault({ version: 2, recipient: workspaceSecretRecipient(), workspaceSecrets: next });
  } catch (err) {
    log.error(
      {
        event: "workspace_secret_vault_save_failed",
        outcome: "secret_change_not_persisted",
        err,
        filePath: WORKSPACE_SECRET_VAULT_FILE,
        ...context,
      },
      "failed to save workspace-secret vault",
    );
    throw err;
  }
  replaceRecord(state.workspaceSecrets, next);
}

/** Sidecar-only reload. Missing or unreadable storage clears live injection rules (fail closed). */
export function reloadWorkspaceSecretVault(): void {
  const next = load();
  state.recipient = next.recipient;
  state.loadError = next.loadError;
  replaceRecord(state.workspaceSecrets, next.workspaceSecrets);
}
