# ADR — Provider key vault, opened only by llm-proxy

Status: Accepted

## Context

Every workspace runs on deployment-wide LLM provider keys, one per provider, that move billing. They are spent on every model call, so they cannot be hashed like PAODO-issued keys. An operator must be able to set or replace one without editing `.env` or restarting. Four things must never reach them: the credential proxy sidecar (it sits on the network path of untrusted workspace containers), the backup set, a leaked CLI token, and the app container itself, which serves agent-written workspace files: one file-access bug there (the `rootedFs` class fixed in #67–#71) would otherwise expose every key.

## Decision

Provider keys live in their own vault, sealed to `llm-proxy`, a separate container that is the only process able to open them. The app stores and lists keys but can never read one back; it sends model calls to `llm-proxy` with a placeholder key.

**Storage** (`lib/infra/security/providerKeyVault.ts`)

- One file, `vault.json` under `PAODO_PROVIDER_VAULT_ROOT`: `{ version: 2, recipient, providerKeys: { <provider>: { createdAt, hint, sealed } } }`. `recipient` is llm-proxy's X25519 public key; `hint` is the last 4 characters, kept readable for the settings page.
- Each key is sealed like a workspace secret (`secretSeal.ts`: ephemeral X25519, HKDF-SHA256, AES-256-GCM) with its own HKDF info and the provider name as authenticated data, so a key moved to another provider's slot cannot be opened.
- The private key is `private.pem` at `PAODO_PROVIDER_PRIVATE_KEY_FILE`, mode `0600`, created by the one-shot `vault-init` job, which also migrates the former AES vault once and keeps `master.key` and a `vault.v1.json` copy beside it for rollback.
- Writes persist first, atomically, then update the in-memory copy, so a failed write cannot leave a key that exists only in memory.

**Isolation**

- `provider-vault` is mounted read-write in the app and read-only in `llm-proxy`. `provider-key` is mounted only in `llm-proxy` (read-only) and `vault-init`. Neither is mounted in `credproxy`.
- `llm-proxy` mounts no workspace data, inherits no `.env`, runs read-only with no capabilities, and is reachable only from the app over `llm_net`, an internal network. Its egress is its own network, never `credproxy_net`, so a workspace cannot reach it through credproxy.
- It forwards `/{provider}/{path}` only to that provider's fixed origin (`lib/infra/llmProxy/upstreams.ts`), drops any credential the caller sent, adds the real key, and streams the reply back with its headers, so rate-limit pacing still works.
- ESLint bans the app from importing the modules that open keys (`secretOpen`, `providerKeyRing`, `providerKeyPrivateKeyPaths`, `providerKeyVaultInit`), and the deployment contract test pins the mounts and networks.
- At startup, `assertSecretStorageSeparated` refuses any layout where workspace data, the proxy CA or either vault share a directory tree.
- The backup set never includes vaults or keys.

**Access** (`lib/infra/security/providerKeyStore.ts` writes keys; only `llm-proxy` reads them)

- The app has no way to read a key. `buildTools` puts a placeholder in the run's `LLMProviderConfig` when the provider has a key, and every client in `buildModel.ts` points at that provider's `llm-proxy` route.
- The app gets `ProviderKeyMeta` only (provider, `createdAt`, last 4 characters as a hint). Set, delete and purge are audit-logged without the value.
- Keys are entered in the UI (Settings → Provider API keys) through `GET /api/settings/provider-keys` and `PUT`/`DELETE /api/settings/provider-keys/[provider]`, all `Cache-Control: no-store`.
- These routes are left out of `platformAccessPolicy.ts`, so the CLI token can neither read hints nor change keys. The CLI only sees `hasKey` through `/api/models`.
- A key is only trimmed and checked to be non-blank; a wrong key surfaces on the next run as `PROVIDER_KEY_INVALID`.

**Lifecycle**

- Only a provider with `<PROVIDER>_AVAILABLE=true` can hold a key.
- At startup, before listening, keys of withdrawn providers are deleted for good (`purgeProviderKeysExcept`), and workspaces using them go back to the default provider.
- Startup fails if the vault is missing or unreadable, and `vault-init` stops the deploy if the vault and private key don't match. Nothing starts empty on top of a vault it could not read. `llm-proxy` reloads within a second of a change.
- A run without a key stops with `PROVIDER_KEY_MISSING` before any provider call.

## Consequences

- Keys change from the UI without a restart, and never appear in `.env`, compose files, images or the environment of child processes.
- A compromised credential proxy, a leaked backup, a leaked CLI token or a file-access bug in the app exposes no provider key. An app bug can still make `llm-proxy` *spend* a key, never return it: provider-side spending limits stay recommended.
- The private key sits on the same host as the vault, on another volume. This protects against the app and a copied vault volume, not root on the host. Keys are plaintext in `llm-proxy` memory.
- A restored box has no provider keys: back up the vault and its private key separately, or re-enter the keys. Losing the private key means re-entering every key.
- One more running container, built from the credproxy image (a third bundled entry point).
- Setting `<PROVIDER>_AVAILABLE=false` deletes that provider's key permanently on the next start.
- One key per provider for the whole deployment: every workspace shares its quota and billing.
- In-memory state on `global` ties the vault to single-instance deployment.

## Alternatives considered

- **Keys in `.env`**: a restart to change one, and the value spreads to the process environment, `docker inspect` and every copy of the file.
- **Former design, app-only AES vault**: the app held the vault and its symmetric master key, so a file-access bug in the container that serves workspace files would have exposed every key.
- **Reuse the workspace-secret vault**: the credential proxy can decrypt that vault, so compromising the proxy would expose billing keys.
- **Hash like PAODO-issued keys**: the app has to send the plaintext to the provider.
- **External KMS or HashiCorp Vault**: extra infrastructure and a network dependency on every run for a single-box deployment.
- **Format validation on save**: vendors change key formats without notice; the first real call is the reliable check.

## Notes

- Related: [unified credential store](../access/adr-unified-credential-store.md), [workspace secrets credential proxy](../sandbox/adr-workspace-secrets-credential-proxy.md), [platform CLI access policy](../access/adr-platform-cli-access-policy.md), [model gateway](../agent/adr-model-gateway-provider-layer.md), [backup set](../platform/adr-backup-set-restic-offsite.md), [single-instance state](../platform/adr-single-instance-in-process-state.md).
