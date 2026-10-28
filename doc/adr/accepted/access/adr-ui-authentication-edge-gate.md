# ADR — UI authentication and edge request gate

Status: Accepted

## Context

The UI is the instance's admin console: whoever passes its login can manage every workspace, secret and container. Programmatic callers never use that login; they have separate, narrower keys. The operator chooses how the UI is published: a reverse proxy or tunnel, or an identity-aware proxy (IAP) such as Cloudflare Access. A second, public hostname serves the API and MCP to callers that send a Bearer key. The `/ws` WebSocket handshake needs the same protection, but a browser cannot add headers to it. Every check must still hold if the ingress is misconfigured or bypassed.

## Decision

A custom Node server (`server.ts`) puts two gates in front of Next.js and the WebSocket server. Both are built from injected dependencies, so their order can be tested without a listener.

```
browser ──► IAP / tunnel ──► 127.0.0.1:PORT ─┬─ request gate ─► Next.js
                                              └─ upgrade gate ─► /ws
API / MCP client ──► Caddy (API host, route allowlist) ──► app:PORT (same gates)
```

**Request gate** (`lib/infra/server/requestGate.ts`). Every HTTP request goes through these steps in order:

1. **Host.** `Host` must be in the allowlist (loopback, `app`, `PAODO_TRUSTED_HOSTS`, `WORKSPACE_API_DOMAIN`). If `X-Forwarded-Host` is sent, it must match `Host`. Otherwise the gate answers `421`.
2. **Rate limit.** `/api/*` requests are limited per client IP, read from `CF-Connecting-IP`.
3. **Credential** (`checkAuth` in `lib/infra/security/httpAuth.ts`):
   - Agent run/stop `POST` and workspace MCP are `exempt`. Each route checks its own per-workspace Bearer key.
   - Any other `Bearer` token is checked as the instance platform token. A deny-by-default route policy (`platformAccessPolicy.ts`) then decides what it may call, and an unmapped route gets `403`.
   - Anything else must present the UI credential. The UI credential is always refused on the API host.
4. **CSRF.** A mutating `/api/*` request whose `Sec-Fetch-Site` is anything other than `same-origin` or `none` gets `403`.

**UI authentication modes** (`lib/infra/security/uiAuth.ts`). `PAODO_AUTH_MODE` selects exactly one mode. There is no default.

- `basic`: a shared `USERNAME`/`PASSWORD`, compared in constant time, with a Basic challenge.
- `iap`: the proxy authenticates the user at the edge. The app then verifies the proxy's signed JWS assertion from `PAODO_IAP_HEADER`. The check covers the JWKS signature (closed algorithm set), the issuer, the audience (one per instance) and `exp`/`nbf`. This mode sends no challenge.

The gates depend only on the `UiAuthenticator` interface and never branch on the mode. The code stays provider-agnostic: Cloudflare Access is a deployment choice, not a dependency.

**Upgrade gate** (`lib/infra/server/upgradeGate.ts`). A `/ws` handshake is checked for host, then `Origin`, then credential. `Origin` must be a declared UI hostname; loopback is accepted only while none is declared. Because the handshake cannot carry a header, each mode allows one cookie, accepted only on the upgrade:

- `basic` uses `paodo_ws_session` (`wsSession.ts`). The cookie is signed with HMAC, lasts 12 h, and is `HttpOnly` and `SameSite=Strict`. Its key is random per boot. The request gate issues it only after a successful UI login, never for a platform or API key.
- `iap` uses the proxy's own assertion cookie (`PAODO_IAP_COOKIE`), verified the same way as the header.

A rejected handshake gets no `WWW-Authenticate` header.

**Shared lockout.** One `AuthFailureTracker` serves both gates: 5 failures within 60 s blocks an IP. Only a credential that was offered and rejected counts as a failure. A missing credential or a `403` does not.

**Fail closed at startup.** The process exits before listening when the mode is missing or incomplete, a hostname is malformed, or the JWKS endpoint (`uiAuth.prime()`) cannot be reached.

**Ingress contract.**

- The app publishes on `127.0.0.1` only.
- The UI ingress must replace `Host`, `X-Forwarded-Host` and `CF-Connecting-IP`, and must pass `/ws` upgrades.
- The API host is a DNS-direct Caddy (`deploy/caddy/Caddyfile`). Its routes mirror `platformAccessPolicy.ts`, and any other route gets `404 GATEWAY_ROUTE_NOT_ALLOWED`.

**Client.** `lib/client/sessionGuard.ts` handles an expired IAP session. A same-origin call that gets a redirect or `401` reloads the page, so the proxy's login takes over.

## Consequences

- Every request passes through one checkpoint, with a fixed order that tests cover.
- In `iap` mode there are two independent checks: the edge policy and the signature check at the origin. If the edge is bypassed or its policy is too broad, a request still fails.
- The UI credential cannot be used on the public API host, and that host reaches only allowlisted routes. The Caddyfile and `platformAccessPolicy.ts` must change in the same commit.
- `basic` mode gives no per-user identity: one shared password serves the whole instance.
- The lockout counters and the `/ws` session key live in memory. This relies on the single-instance model, and a restart issues new session cookies.
- Lockout and audit are only correct if every ingress overwrites `CF-Connecting-IP`.
- `iap` needs the JWKS endpoint to be reachable at boot. When the provider rotates its keys, one request fails before the keys refresh.
- Switching modes takes one environment variable and a restart.

## Alternatives considered

- **Next.js middleware**: it never sees the WebSocket upgrade and runs after routing, so the host check and lockout could not cover everything.
- **Password and IAP together**: whoever reaches the origin directly could use the password to get around the IAP. The modes stay exclusive.
- **Trusting the IAP header without verifying its signature**: any client that reaches the origin could forge it.
- **App-managed users and login sessions**: more attack surface than a single-operator instance needs. An IAP already provides SSO and one-time PINs.
- **Accepting the session cookie on HTTP**: it would become an ambient credential that only the CSRF check protects.
- **A default mode, or tying auth to `NODE_ENV`**: tying auth to `NODE_ENV` once served every route unauthenticated.

## Notes

- Related ADRs: [adr-platform-cli-access-policy.md](../access/adr-platform-cli-access-policy.md), [adr-per-workspace-api-key-http-endpoint.md](../access/adr-per-workspace-api-key-http-endpoint.md), [adr-workspace-mcp-skill-gateway.md](../access/adr-workspace-mcp-skill-gateway.md), [adr-single-instance-in-process-state.md](../platform/adr-single-instance-in-process-state.md).
- Deployment: `deploy/README.md` §4–5. Configuration: `.env.example`.
