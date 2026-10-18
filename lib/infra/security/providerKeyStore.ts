// Deployment-wide provider keys (one per provider), entered in the app. Encrypted, not hashed, since the app
// spends them; own vault and key on app-only mounts, so the proxy and backups can't recover them.
import { createAuditLogger } from "../logger";
import {
  PROVIDER_VAULT_FILE,
  assertProviderVaultAvailable,
  commitProviderKeys,
  providerKeyRecords,
  type VaultProviderKeyEntry,
  type VaultProviderKeys,
} from "./providerKeyVault";

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

// Production startup calls this before accepting requests, so an empty fallback can never overwrite
// a store that existed but could not be read or decrypted. Mirrors assertSecretStoreAvailable().
export function assertProviderKeyStoreAvailable(): void {
  assertProviderVaultAvailable();
}

function save(next: Store, context: { operation: string; provider?: string }): void {
  commitProviderKeys(next, context);
}

// Enough to tell keys apart, too little to use; keys shorter than this can't be real, so show them whole.
const HINT_LENGTH = 4;

function hintFor(value: string): string {
  return value.length <= HINT_LENGTH ? value : value.slice(-HINT_LENGTH);
}

// The only way a key leaves this module; never log it. `undefined` means none entered yet, which
// callers treat as "cannot run", not an error.
export function getProviderKey(provider: string): string | undefined {
  return store[provider]?.value;
}

/** Whether a provider has a key set. The coarse status safe to publish in the model catalog. */
export function hasProviderKey(provider: string): boolean {
  return store[provider] !== undefined;
}

/** Store (or replace) a provider's key. Replacing in place — there is no rotation ceremony. */
export function setProviderKey(provider: string, value: string): void {
  const next = structuredClone(store);
  next[provider] = { value, createdAt: new Date().toISOString() } satisfies VaultProviderKeyEntry;
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
    hint: hintFor(entry.value),
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
