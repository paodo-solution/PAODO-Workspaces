// Live store for provider API keys. Keys are sealed to llm-proxy's public key, so the app reads and writes
// this vault without any key and never sees a value back; vault-init creates it and migrates the former format.
import { createLogger } from "../logger";
import {
  PROVIDER_VAULT_FILE,
  readProviderVault,
  saveProviderVault,
  type VaultProviderKeys,
} from "./providerKeyVaultFormat";

export { PROVIDER_VAULT_FILE, type VaultProviderKeyEntry, type VaultProviderKeys } from "./providerKeyVaultFormat";

const log = createLogger("providerKeyVault");

interface ProviderVaultState {
  recipient: string | null;
  providerKeys: VaultProviderKeys;
  loadError: unknown;
}

// Any failure leaves the store unavailable, so the startup assert refuses to start. A missing vault is not
// logged here: it is the normal state of a process with no vault, and the assert names the cause.
function load(): ProviderVaultState {
  try {
    const data = readProviderVault();
    return { recipient: data.recipient, providerKeys: data.providerKeys, loadError: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const missing = new Error("provider vault is missing — the vault-init job creates it");
      return { recipient: null, providerKeys: {}, loadError: missing };
    }
    log.error(
      { event: "provider_vault_load_failed", outcome: "vault_unavailable", err, filePath: PROVIDER_VAULT_FILE },
      "failed to load provider vault — no provider key can be stored or used",
    );
    return { recipient: null, providerKeys: {}, loadError: err };
  }
}

const g = global as typeof global & { _providerKeyVaultState?: ProviderVaultState };
g._providerKeyVaultState ??= load();
const state = g._providerKeyVaultState;

function replaceRecord(target: VaultProviderKeys, next: VaultProviderKeys): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, next);
}

export function assertProviderVaultAvailable(): void {
  if (state.loadError) throw state.loadError;
}

export function providerKeyRecords(): VaultProviderKeys {
  return state.providerKeys;
}

/** The key new values are sealed to. Throws while the vault is unavailable, so nothing is sealed to nothing. */
export function providerKeyRecipient(): string {
  if (!state.recipient) throw new Error("provider vault is unavailable — new provider keys cannot be stored");
  return state.recipient;
}

/** Persist first, then publish the new state so a failed write cannot create an in-memory-only key. */
export function commitProviderKeys(next: VaultProviderKeys, context: Record<string, unknown>): void {
  try {
    saveProviderVault({ version: 2, recipient: providerKeyRecipient(), providerKeys: next });
  } catch (err) {
    log.error(
      {
        event: "provider_vault_save_failed",
        outcome: "provider_key_change_not_persisted",
        err,
        filePath: PROVIDER_VAULT_FILE,
        ...context,
      },
      "failed to save provider vault",
    );
    throw err;
  }
  replaceRecord(state.providerKeys, next);
}

/** llm-proxy-only reload. Missing or unreadable storage clears every key (fail closed). */
export function reloadProviderVault(): void {
  const next = load();
  state.recipient = next.recipient;
  state.loadError = next.loadError;
  replaceRecord(state.providerKeys, next.providerKeys);
}
