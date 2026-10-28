# ADR — Encrypted provider key vault, app-only

Status: Accepted

## Context

Every workspace runs on deployment-wide LLM provider keys, one per provider, that move billing. The app must spend them, so they cannot be hashed like PAODO-issued keys. An operator must be able to set or replace one without editing `.env` or restarting. Three components must never reach them: the credential proxy sidecar (it sits on the network path of untrusted workspace containers), the backup set, and a leaked CLI token.

## Decision

Provider keys live in their own encrypted vault, readable only by the app process.

**Storage** (`lib/infra/security/providerKeyVault.ts`)

- One file, `vault.json` under `PAODO_PROVIDER_VAULT_ROOT`, holding a single AES-256-GCM envelope over `{ version: 1, providerKeys: { <provider>: { value, createdAt } } }`.
- A 32-byte master key at `PAODO_PROVIDER_KEY_FILE`, generated on first use with mode `0600`. It shares envelope code with the workspace-secret vault (`vaultEncryption.ts`) but never its key or cache slot.
- Writes persist first, atomically, then update the in-memory copy, so a failed write cannot leave a key that exists only in memory.

**Isolation**

- `provider-vault` and `provider-key` are separate Docker volumes mounted only in the app container. The credential proxy image is built without this code and mounts neither.
- At startup, `assertSecretStorageSeparated` refuses any layout where workspace data, either vault or either master key share a directory tree.
- The backup set never includes vaults or keys.

**Access** (`lib/infra/security/providerKeyStore.ts` is the only module holding values)

- `getProviderKey` has one consumer: `buildTools` puts it in the run's `LLMProviderConfig` for the model gateway.
- Everything else gets `ProviderKeyMeta` only (provider, `createdAt`, last 4 characters as a hint). Set, delete and purge are audit-logged without the value.
- Keys are entered in the UI (Settings → Provider API keys) through `GET /api/settings/provider-keys` and `PUT`/`DELETE /api/settings/provider-keys/[provider]`, all `Cache-Control: no-store`.
- These routes are left out of `platformAccessPolicy.ts`, so the CLI token can neither read hints nor change keys. The CLI only sees `hasKey` through `/api/models`.
- A key is only trimmed and checked to be non-blank; a wrong key surfaces on the next run as `PROVIDER_KEY_INVALID`.

**Lifecycle**

- Only a provider with `<PROVIDER>_AVAILABLE=true` can hold a key.
- At startup, before listening, keys of withdrawn providers are deleted for good (`purgeProviderKeysExcept`), and workspaces using them go back to the default provider.
- Startup fails if vault storage is missing, or if an existing vault cannot be decrypted. It never starts empty on top of a vault it could not read.
- A run without a key stops with `PROVIDER_KEY_MISSING` before any provider call.

## Consequences

- Keys change from the UI without a restart, and never appear in `.env`, compose files, images or the environment of child processes.
- A compromised proxy, a leaked backup or a leaked CLI token exposes no provider key.
- The master key sits on the same host as the vault, on another volume. This protects a copied vault volume, not root on the host. Keys are plaintext in app memory.
- A restored box has no provider keys: back up the vault and its master key separately, or re-enter the keys. Losing the master key means re-entering every key.
- Setting `<PROVIDER>_AVAILABLE=false` deletes that provider's key permanently on the next start.
- One key per provider for the whole deployment: every workspace shares its quota and billing.
- In-memory state on `global` ties the vault to single-instance deployment.

## Alternatives considered

- **Keys in `.env`**: a restart to change one, and the value spreads to the process environment, `docker inspect` and every copy of the file.
- **Reuse the workspace-secret vault**: the credential proxy can decrypt that vault, so compromising the proxy would expose billing keys.
- **Hash like PAODO-issued keys**: the app has to send the plaintext to the provider.
- **External KMS or HashiCorp Vault**: extra infrastructure and a network dependency on every run for a single-box deployment.
- **Format validation on save**: vendors change key formats without notice; the first real call is the reliable check.

## Notes

- Related: [unified credential store](../access/adr-unified-credential-store.md), [workspace secrets credential proxy](../sandbox/adr-workspace-secrets-credential-proxy.md), [platform CLI access policy](../access/adr-platform-cli-access-policy.md), [model gateway](../agent/adr-model-gateway-provider-layer.md), [backup set](../platform/adr-backup-set-restic-offsite.md), [single-instance state](../platform/adr-single-instance-in-process-state.md).
