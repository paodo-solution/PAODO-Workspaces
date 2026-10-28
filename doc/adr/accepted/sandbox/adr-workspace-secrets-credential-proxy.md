# ADR — Workspace secrets via a MITM credential proxy

Status: Accepted

## Context

Agents need third-party credentials, but they run untrusted code that can read its own environment, so a real value in the container could be printed, logged, or leaked. The agent must _use_ a credential without ever _holding_ it, and installs and clones must keep working through unmodified tools. This is leak resistance, not a hardened secrets manager (see Consequences).

## Decision

A transparent credential proxy swaps opaque tokens for real values on outbound HTTPS.

1. **Tokens in the container, values in a vault.** Each secret is scoped to exact domains and stored in an AES-256-GCM vault whose key sits on a separate volume; provider API keys have their own vault, mounted only by the app. An unreadable vault is rejected, never replaced. The container receives a stable, non-secret token per secret as an environment variable on every command (the github.com one also as `GH_TOKEN`), so changes apply without recreating the container. No tokens are passed while internet access is off.
2. **The sidecar is the only way out.** Each workspace sits on an `--internal` network to which the app attaches the `credproxy` sidecar. Tools reach it through an in-container relay, running as a user the agent can neither read nor signal, that adds the workspace's HMAC-signed proxy identity.
3. **Every connection is authenticated and checked.** A missing or wrong identity gets `407`, so no connection skips the checks. Internet off or a host outside the allowlist gets `403` before any upstream is contacted, and a tightened policy closes open tunnels.
4. **TLS interception only for a secret's exact host.** For a host matching a secret's domain (subdomains excluded), the proxy terminates TLS with its own CA, substitutes tokens in the request target, every header (including inside base64 `Authorization: Basic`, as git and `gh` send) and bodies up to 10 MB, then re-encrypts to the upstream with full certificate verification. Larger bodies pass unsubstituted. Every other host is a plain tunnel. Plain HTTP is never substituted: the token travels as-is and the upstream rejects it.
5. **Responses are redacted.** On intercepted connections, real values, and the `Basic` envelopes the proxy built, are swapped back to tokens. Bodies stream while holding back the longest value's length minus one byte, so a value split across chunks is caught without stalling server-sent events.
6. **SSRF guard on every connection.** Non-public addresses are blocked (loopback, private ranges, CGNAT, the 169.254 metadata endpoint, IPv6 local ranges), including IPv4-mapped IPv6 in dotted and hex form. The check applies to the address actually connected to, closing the DNS-rebinding gap; unparseable input fails closed.
7. **A minimal sidecar.** The app generates the CA and HMAC key; containers trust the CA. The sidecar contains only the proxy on a read-only filesystem, mounts the CA and the workspace-secret vault read-only, inherits no app `.env`, and has no route to the app. It reloads the vault and internet policy the app writes; an unreadable vault clears every rule.

## Consequences

- Agents use credentials they never possess: a leaked echo exposes only the token, each secret reaches only its exact host, and neither a vault snapshot without its key nor a workspace backup reveals a credential.
- The CA, HMAC and vault keys are sensitive host assets. The sidecar can decrypt workspace secrets by design, never provider keys.
- One shared process sits on every container's egress, with header and body size bounds against memory exhaustion; the SSRF guard is load-bearing platform-wide, so changes to it are security-critical.
- Scope: token-based APIs only. Signed requests (AWS S3/SigV4, HMAC signing, SCRAM) fail rather than leak, logged as `credential_rejected_by_upstream`.
- Does NOT stop: an attacker with host access, including one who escapes a workspace container through the shared host kernel; exfiltration through an upstream the agent deliberately steers; a transformed echo of the secret other than the `Basic` envelopes.

## Alternatives considered

- **Broker with a bespoke API**: breaks transparent `curl`/`requests`, which already honour `HTTP_PROXY`.
- **External secrets manager (Vault)**: heavy for a single VPS, and the value still reaches the container.
- **Proxy inside the app**: would put the control plane on every workspace network.
- **Host allowlist instead of an IP-class SSRF guard**: breaks installs spanning many hosts.
- **Subdomain matching**: a key must never leak to a sibling host.

## Notes

- Code: `lib/infra/proxy/` (`credentialProxy.ts`, `destinationGuard.ts`, `httpWire.ts`, `proxyCA.ts`), `lib/infra/security/workspaceSecretStore.ts`, `lib/infra/docker/proxyRelay.ts`.
- Related: [adr-container-per-workspace-sandbox.md](adr-container-per-workspace-sandbox.md), [adr-workspace-internet-access-toggle.md](adr-workspace-internet-access-toggle.md), [adr-workspace-domain-allowlist.md](adr-workspace-domain-allowlist.md), [prd-workspace-third-party-api-keys.md](../../../prd/accepted/prd-workspace-third-party-api-keys.md).
