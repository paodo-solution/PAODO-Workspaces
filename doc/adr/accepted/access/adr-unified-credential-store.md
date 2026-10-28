# ADR — Unified credential store for every PAODO-issued key

Status: Accepted

## Context

PAODO issues three bearer keys, one per programmatic access channel:

| Channel        | Prefix | Scope             |
| -------------- | ------ | ----------------- |
| HTTP agent API | `sk_`  | one per workspace |
| Workspace MCP  | `mcp_` | one per workspace |
| CLI / platform | `cli_` | one per instance  |

All three need the same lifecycle (generate, rotate, revoke, enable/disable, validate) and the same guarantee: a key must never be readable after it is issued.

## Decision

One module, `lib/infra/security/credentialStore.ts`, owns every PAODO-issued key.

- **One record per `(kind, subject)`**: `kind` is `workspace-api`, `workspace-mcp` or `platform`; `subject` is a workspace id, or none for the instance-wide platform key. Each channel has exactly one key.
- **One lifecycle for all three**: `mint` (generate or rotate; the plaintext is returned once), `revoke`, `setEnabled`, `state`, `validate`, `remove`, and `removeWorkspace` for workspace deletion.
- **Hashes never leave the module.** Keys are stored only as SHA-256 hashes, and `state` returns public fields only, so no route can expose one.
- **The key and the channel's on/off flag are independent.** A key works only while the channel is enabled; minting never enables a channel, and revoking never disables one.
- **`validate` fails closed** on any doubt, including a corrupted stored hash, and compares in constant time.
- **Storage** is `.credentials.json` in the data root, through `globalSingleton`, like the app's other configuration stores. `lastUsedAt` is refreshed at most once a minute, on a best-effort basis.
- **Prefixes** are derived from `kind`, so a leaked key is identifiable in a log or a secret scanner.

The route layer (`lib/api/credentialRoutes.ts`) and the UI (`useCredential`, `CredentialPanel`) are shared by all three channels.

Workspace keys are checked in their routes. The platform key is checked at the edge in `server.ts`, then limited to the routes allowed in `platformAccessPolicy.ts`; it cannot reach the route that mints it. A wrong key counts toward brute-force lockout; a valid key on a route it may not use does not, since the tracker is shared with the UI login.

Naming: **"key"** means a PAODO-issued, one-way-hashed credential. **"Secret"** means a third-party value stored with reversible encryption for the credential proxy (`workspaceSecretStore`). The two never share a name.

## Consequences

- Every channel can be revoked, rotated and disabled the same way.
- Hashing and comparison are implemented once, and one set of audit events (`credential_minted`, `credential_revoked`, `credential_enabled_changed`, `credential_removed`) covers every channel.
- Adding a channel means adding a `kind`, mounting the shared handlers and reusing the panel.
- Enabling a channel and creating its key are two separate steps in the UI.
- A bug in this module affects all three channels at once; `credentialStore.test.ts` runs the fail-closed checks for each kind.
- `lastUsedAt` is approximate (one-minute resolution) and is not an audit timestamp.

## Alternatives considered

- **A SQLite `tokens` table**: exact `lastUsedAt`, but a second storage pattern for configuration data, and SQLite on the edge auth path.
- **One shared key for all channels**: the channels have different exposure (agent and MCP endpoints are public; the CLI key is instance-wide) and different owners.
- **Several keys per channel**: would allow rotation without downtime, but adds ids and a lookup layer the product does not need.
- **Separate credential and feature flags**: two checks where one suffices, and a route that forgets one fails open.
- **Storing third-party secrets here too**: they must be decryptable by the credential proxy, a different primitive from one-way-hashed keys.
- **Including the UI login**: that is a human login, not an issued key.

## Notes

- Related: [adr-per-workspace-api-key-http-endpoint.md](adr-per-workspace-api-key-http-endpoint.md), [adr-workspace-mcp-skill-gateway.md](adr-workspace-mcp-skill-gateway.md), [adr-workspace-secrets-credential-proxy.md](../sandbox/adr-workspace-secrets-credential-proxy.md), `doc/prd/draft/prd-cli-access.md`.
