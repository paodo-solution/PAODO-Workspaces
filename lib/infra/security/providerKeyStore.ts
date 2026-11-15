// Deployment-wide provider keys (one per provider), entered in the app. Sealed to llm-proxy, which spends
// them: this side stores, lists and deletes keys but can never read one back.
import { createAuditLogger } from "../logger";
import {
  PROVIDER_VAULT_FILE,
  assertProviderVaultAvailable,
  commitProviderKeys,
  providerKeyRecipient,
  providerKeyRecords,
  type VaultProviderKeys,
} from "./providerKeyVault";
import { hintFor, sealProviderKey, type VaultProviderKeyEntry } from "./providerKeyVaultFormat";

const audit = createAuditLogger("providerKeyStore");

export const PROVIDER_KEY_STORE_FILE = PROVIDER_VAULT_FILE;
type Store = VaultProviderKeys;

/** Everything about a stored key EXCEPT the key. The only shape that leaves this module by API. */
export interface ProviderKeyMeta {
  provider: string;
  createdAt: string;
  /** The last few characters, so an operator can tell which key is loaded without revealing it. */
  hint: string;
}

const store: Store = providerKeyRecords();

// Production startup calls this before accepting requests, so a missing or unreadable vault stops the app
// rather than showing every provider as keyless. Mirrors assertSecretStoreAvailable().
export function assertProviderKeyStoreAvailable(): void {
  assertProviderVaultAvailable();
}

function save(next: Store, context: { operation: string; provider?: string }): void {
  commitProviderKeys(next, context);
}

/** Whether a provider has a key set. The coarse status safe to publish in the model catalog. */
export function hasProviderKey(provider: string): boolean {
  return store[provider] !== undefined;
}

/** Store (or replace) a provider's key. Replacing in place — there is no rotation ceremony. */
export function setProviderKey(provider: string, value: string): void {
  const next = structuredClone(store);
  next[provider] = {
    createdAt: new Date().toISOString(),
    hint: hintFor(value),
    sealed: sealProviderKey(value, providerKeyRecipient(), provider),
  } satisfies VaultProviderKeyEntry;
  save(next, { operation: "set_provider_key", provider });
  audit.info({ event: "provider_key_set", provider }, "provider API key set");
}

/** Remove a provider's key. Returns false when there was nothing stored. */
export function deleteProviderKey(provider: string): boolean {
  if (!store[provider]) return false;
  const next = structuredClone(store);
  delete next[provider];
  save(next, { operation: "delete_provider_key", provider });
  audit.info({ event: "provider_key_deleted", provider }, "provider API key deleted");
  return true;
}

/** Every stored key's metadata. Never carries a value — see ProviderKeyMeta. */
export function listProviderKeyMeta(): ProviderKeyMeta[] {
  return Object.entries(store).map(([provider, entry]) => ({
    provider,
    createdAt: entry.createdAt,
    hint: entry.hint,
  }));
}

// Irreversibly deletes keys of withdrawn providers, so `<PROVIDER>_AVAILABLE=false` stops all spend.
// The caller passes `allowed` because the registry (buildModel.ts) pulls in the LLM SDKs.
export function purgeProviderKeysExcept(allowed: readonly string[]): string[] {
  const keep = new Set(allowed);
  const purged = Object.keys(store).filter((provider) => !keep.has(provider));
  if (purged.length === 0) return [];
  const next = structuredClone(store);
  for (const provider of purged) delete next[provider];
  save(next, { operation: "purge_withdrawn_provider_keys" });
  for (const provider of purged) {
    audit.warn(
      { event: "provider_key_purged", outcome: "stored_key_destroyed", provider },
      "provider withdrawn by configuration — its stored API key was deleted",
    );
  }
  return purged;
}

/** Test-only: drop everything in memory so one case's keys cannot decide another's outcome. */
export function _resetProviderKeysForTest(): void {
  for (const provider of Object.keys(store)) delete store[provider];
}
