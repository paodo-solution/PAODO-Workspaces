Title: Per-workspace domain allowlist for internet access

Status: Accepted

Context
Internet access is all or nothing (see
[adr-workspace-internet-access-toggle.md](adr-workspace-internet-access-toggle.md)). Many workspaces
need only a few services. A workspace that manages a web app, for example, needs `api.vercel.com`,
not the whole internet. Open access leaves every public host available as a place to send data or
to fetch injected instructions from, while "off" blocks the one API the workspace exists for. Every
connection out of a workspace already goes through the credential proxy as `CONNECT host` or a
plain-HTTP request line (see
[adr-workspace-secrets-credential-proxy.md](adr-workspace-secrets-credential-proxy.md)). The proxy
therefore already sees the hostname of every request, and can refuse one without decrypting
anything.

This is a middle setting between on and off, not a replacement for off. The toggle ADR rejected
filtering _as the way to implement off_, because off must not depend on trusting a filter. That
still holds: off keeps its network-layer guarantee, and the allowlist applies only while internet
access is on.

Decision

1. **Exact hostnames, no wildcards.** An entry matches one host, compared case-insensitively and
   ignoring a trailing dot: `wikipedia.org` covers neither `fr.wikipedia.org` nor the
   `www.wikipedia.org` it redirects to. This is the same rule as third-party secrets'
   allowed domains (`hostMatches`), so one sentence explains both lists. Secrets can't safely
   take wildcards, because a key would then reach any subdomain, including ones a vendor gives to
   its customers or that someone has taken over. Both lists must follow one rule, so the
   allowlist doesn't take wildcards either.
2. **One format check for both lists.** `lib/workspace/domain.ts` holds `normalizeDomain`,
   `isValidDomain` and the UI error text. It's a pure module, so the browser and the server run
   the same check, and the proxy sidecar bundles it through a relative import.
3. **Model.** `Workspace.domainAllowlist?: { restricted, domains }` lives in the registry. When
   absent, the workspace is unrestricted. The list is kept while `restricted` is off, so turning
   the restriction back on restores it.
4. **An empty list restricts nothing.** `enforcedDomains()` is the single rule for whether a
   restriction applies: it applies only when `restricted` is on and the list has at least one
   domain. The proxy policy, the agent prompt, `blockedBy` on secrets and the UI all go through
   it, so they can't disagree. In the UI, "On" stays grey until a domain is added. This was a
   product choice: turning the switch on shouldn't cut the workspace off before its first domain
   is entered.
5. **Enforcement in the proxy.** The sidecar's policy file (`internetAccessPolicy.ts`) now maps
   each workspace to `false` (internet off), `string[]` (restricted to these hosts) or nothing
   (open). Internet off wins over the allowlist. `credentialProxy.ts` checks `isHostAllowed`
   right after the internet-off check, for both CONNECT and plain HTTP, and before any upstream
   connection or MITM, so a refused host is never contacted. A refusal gets a 403 and a
   throttled `proxy_domain_not_allowed` audit line. The throttle records the refused hosts
   themselves (`suppressedHosts`), so a throttled window still names every host the user might
   need to add.
6. **Secrets are not exempt.** A secret's host is reachable only if it's also on the allowlist. The
   allowlist is the one place that decides where the agent can go. A secret whose hosts are all
   unlisted shows `blockedBy: "domainAllowlist"` in the API, CLI and MCP; the prompt marks each
   unlisted host "(blocked: … not allowed)". The app shows no note.
7. **The agent is told.** `promptContext.ts` adds a "RESTRICTED" section listing the hosts. It tells
   the agent that subdomains and redirect targets need their own entry, and that a refused host
   should be named to the user rather than retried.
8. **Updates.** `domainRestriction` and `allowedDomains` join the shared update path, so UI, REST,
   CLI and MCP all go through it. The list holds at most 100 valid domains, normalized and
   deduplicated, and either field can be sent alone. The registry is written first, then the
   policy file; if the policy write fails, the registry is rolled back. The container is never
   touched.

Consequences

- Exact matching makes the user find out every host a task uses. A git clone from GitHub, for
  example, needs `github.com`, `codeload.github.com` and `objects.githubusercontent.com`. For now
  the refusal log and the agent's prompt cover this; a "recently refused hosts" list in the UI
  would make it much easier.
- The allowlist limits where the agent can go, not what it does there. An allowed host is still a
  way for data to leave, and a host that serves anyone's content (`github.com`,
  `raw.githubusercontent.com`, package registries) is a way for anyone's content to reach the
  agent. Paths aren't checked: for HTTPS the proxy sees only the host.
- Changes apply within one policy poll (about a second). On each reload the sidecar also closes open
  tunnels to hosts it now refuses (`proxy_tunnel_closed_by_policy`), so a long-lived connection can't
  outlast a narrowed list. A request with an injected secret already uses its own connection, so it
  needs no such step.
- A malformed saved allowlist doesn't stop the app. That workspace's internet access is turned off
  and `workspace_domain_allowlist_malformed` is logged. Falling back to an empty list would allow
  everything; refusing to start would take down every workspace for one bad record.
- **Deploy the app and the sidecar together.** An older sidecar reads a list entry as "enabled" and
  allows everything.

Alternatives considered

- Wildcards (`*.wikipedia.org`), possibly refused on shared hosting suffixes from the Public Suffix
  List: rejected for now, because secrets must stay exact-only and both lists should follow one
  rule. They could be added later without breaking anything.
- Path rules (`api.vercel.com/v9/*`): rejected, because they would mean decrypting every allowed
  connection, which costs more and makes failures harder to understand.
- An empty list blocks everything: rejected after testing, because turning the switch on would cut
  the workspace off until its first domain. This would have been the safer default, and the
  malformed-record fallback above keeps that safety where it matters.
- Allowing a secret's hosts automatically: rejected, because then the list on screen would no
  longer show everything the agent can reach.

Notes
See [prd-workspace-internet-access-toggle.md](../prd/accepted/prd-workspace-internet-access-toggle.md) for the product framing.
