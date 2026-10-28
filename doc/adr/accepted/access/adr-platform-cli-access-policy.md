# ADR — Instance-wide CLI key with deny-by-default route policy

Status: Accepted

## Context

The `paodo` CLI manages a whole instance from a terminal: workspaces, drives, files, schedules and the graph. The per-workspace API and MCP keys are scoped to one workspace's agent, and the UI credential is a browser login that must not be scripted against the public API host. The CLI needs a credential of its own that can reach many routes, without that key becoming a second admin password: a leaked CLI key must not renew itself, move billing, or start agent runs.

## Decision

**One instance-wide key.** The CLI token is the `platform` kind in the unified credential store (`cli_` prefix, SHA-256 hash only, no subject). Like the other keys, it has two independent axes: an `enabled` flag and the key, and it works only while both are set. It is minted, rotated, revoked and toggled only from `/api/settings/cli-access`, which is UI-only.

**Deny by default.** [platformAccessPolicy.ts](../../../../lib/infra/security/platformAccessPolicy.ts) is the single list of `METHOD + path` rules the token may call. Any route not listed there stays UI-only. Rules are generated (`workspaceRule`, `driveRule`) rather than hand-written regexes, so an unescaped dot or a missing `$` cannot quietly widen access.

**Enforced in the request gate, before Next.js.** `checkAuth` in [httpAuth.ts](../../../../lib/infra/security/httpAuth.ts) handles any `Bearer` request in this order:

1. The token is validated (fail closed, constant-time). A bad secret returns `401` and counts toward the per-IP lockout.
2. The route is checked against the policy. A valid token on an unlisted route returns `403`. This does not count toward the lockout, so a script polling the wrong route cannot lock out its operator.
3. A request that passes reaches the route as `platform`. It never becomes a UI session or mints the `/ws` cookie.

The agent (`/agent`, `/agent/stop`) and MCP routes are exempt and authenticate with their own per-workspace keys.

**What is shared, and what is deliberately absent:**

| Granted | Withheld |
|---|---|
| Workspaces: list, create, read, `PATCH`, delete | `settings/cli-access`: a leaked key must not renew itself |
| Issue and revoke the API and MCP keys (`POST`/`DELETE` on `api-key`, `mcp-config`) | Reading or toggling those channels (done through workspace `GET`/`PATCH`) |
| Files: list, read, delete, and `files/transfer` push and pull | Browser upload and editor routes |
| Schedule: read, replace, update (pausing is `enabled: false`) | Starting, continuing or stopping a conversation (API/MCP only) |
| Conversations, sessions and calls: read only | `settings/provider-keys`, all methods: no key hints, no spend redirection |
| Drives (same file surface as workspaces), drive links, graph edges, `connections` | `PUT /api/workspace-graph`, which would erase canvas layout |
| `GET /api/status`, `/api/models` (catalog with a `hasKey` boolean), `/api/contract` | |

**A versioned contract for a client shipped separately.** The CLI is a public npm package that cannot import app code. `GET /api/contract` publishes settable fields, channels, limits and vocabularies, all built from the constants their validators enforce. Every `/api/` response carries `X-Paodo-Contract: <PLATFORM_CONTRACT_VERSION>`. [surface.test.ts](../../../../lib/operations/contract/surface.test.ts) snapshots the rule list together with the contract's shape. Adding a rule only updates the snapshot. Removing one, or changing a route in a way that breaks callers, also bumps the version.

## Consequences

- One token drives the whole CLI. Its blast radius is the rule list, which can be reviewed in one file.
- Each new route is UI-only until someone adds a rule, so widening access is always a deliberate, reviewed diff.
- A leaked token can still do real damage inside the granted surface: delete workspaces and drives, rotate agent keys, overwrite files. Revoking or disabling the key from the UI is the remedy.
- Path matching is coupled to Next.js route paths. Renaming a route silently drops CLI access until its rule is updated, and the surface test catches this.
- `401` vs `403` tells the operator whether the secret or the route is wrong, and the `403` message is the same for every unshared route.

## Alternatives considered

- **Reuse the UI credential for scripting**: it would expose every route, including key administration, and it is refused on the API host by design.
- **Per-workspace keys for the CLI**: instance-level commands (create, list, graph, drives) have no single workspace to scope to.
- **Allow-by-default with a denylist**: every new route would be exposed to the token the day it ships.
- **Scoped or multiple platform tokens (OAuth, per-scope keys)**: more machinery than a single-operator, self-hosted instance needs. Revisit if several operators share an instance.

## Notes

- Related ADRs: [adr-unified-credential-store.md](adr-unified-credential-store.md), [adr-per-workspace-api-key-http-endpoint.md](adr-per-workspace-api-key-http-endpoint.md), [adr-workspace-mcp-skill-gateway.md](adr-workspace-mcp-skill-gateway.md), [adr-ui-authentication-edge-gate.md](adr-ui-authentication-edge-gate.md), [adr-provider-key-vault.md](adr-provider-key-vault.md).
- Code: [platformAccessPolicy.ts](../../../../lib/infra/security/platformAccessPolicy.ts), [httpAuth.ts](../../../../lib/infra/security/httpAuth.ts) (`checkAuth`), [requestGate.ts](../../../../lib/infra/server/requestGate.ts), [credentialStore.ts](../../../../lib/infra/security/credentialStore.ts), [cli-access/route.ts](../../../../app/api/settings/cli-access/route.ts), [fields.ts](../../../../lib/operations/contract/fields.ts).
