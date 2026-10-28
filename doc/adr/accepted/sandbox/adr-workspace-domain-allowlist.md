# ADR — Per-workspace domain allowlist for internet access

Status: Accepted

## Context

Many workspaces need only a few services: one that manages a web app needs `api.vercel.com`, not the whole internet. Full internet access leaves every public host available to send data to or fetch injected instructions from, while turning internet off blocks the one API the workspace exists for.

Every connection out of a workspace already goes through the credential proxy, which sees the hostname of each request before connecting, so it can refuse a host without decrypting anything. The allowlist is a middle setting while internet access is on; internet off keeps its own network-level guarantee (see [adr-workspace-internet-access-toggle.md](adr-workspace-internet-access-toggle.md)).

## Decision

A workspace can restrict internet access to a list of allowed domains, enforced by the credential proxy.

- **Exact hostnames, no wildcards.** An entry matches one host, case-insensitively: `wikipedia.org` covers neither `fr.wikipedia.org` nor `www.wikipedia.org`. Third-party secrets use the same rule, from the same module (`lib/workspace/domain.ts`), which the browser, the server and the proxy all share.
- **An empty list blocks every host.** When the restriction is on, only listed hosts are reachable; with no domain set, none are. A half-finished setup fails closed, and the UI shows a red "No allowed domain is set" warning. The list is kept while the restriction is off, so turning it back on restores it.
- **Internet off wins** over the allowlist.
- **Enforced before connecting.** The proxy checks the host for both HTTPS and plain HTTP before contacting any upstream; a refused host gets a `403` and a throttled `proxy_domain_not_allowed` log line naming the host.
- **Secrets are not exempt.** A secret's host is reachable only if it is also listed, so the allowlist alone shows where the agent can go. A secret whose hosts are all unlisted is reported as `blockedBy: "domainAllowlist"`.
- **The agent is told.** Its system prompt lists the allowed hosts, explains that subdomains and redirect targets need their own entry, and tells it to name a refused host to the user rather than retry. A refused request is turned into one plain explanation in the tool output.
- **One update path** for UI, REST, CLI and MCP. The list is always replaced whole (at most 100 domains, normalized and deduplicated), and one invalid entry rejects the whole update. The registry and the proxy policy are written together, with rollback on failure; the container is never restarted.

## Consequences

- Users must list every host a task uses. A `git clone` from GitHub needs `github.com`, but a repository archive needs `codeload.github.com`. The refusal log and the agent's instruction to name refused hosts make this discoverable.
- The allowlist limits where the agent can go, not what it does there: an allowed host can still receive data, and a host serving anyone's content (`raw.githubusercontent.com`, package registries) can still deliver injected content. Paths are not checked.
- Changes reach the proxy within about a second. The proxy then closes open connections to hosts it now refuses, so a long-lived connection cannot outlast a narrowed list.
- A malformed saved allowlist turns that workspace's internet access off instead of leaving it open or stopping the app.
- The app and the proxy must be deployed together: an older proxy treats a restricted workspace as open.

## Alternatives considered

- **Wildcards (`*.wikipedia.org`)**: rejected for now; secrets must stay exact-only, since a key would otherwise reach any subdomain, and both lists follow one rule. They could be added later without breaking anything.
- **Path rules (`api.vercel.com/v9/*`)**: would require decrypting every allowed connection, at higher cost and with harder-to-explain failures.
- **An empty list restricts nothing**: the switch would say "restricted" while every host is reachable, failing open in the state users most often leave half-done.
- **Allowing a secret's hosts automatically**: the list on screen would no longer show everything the agent can reach.
- **Adding and removing domains one at a time**: two ways to change one list; a workspace has one person configuring it, so replacing the whole list is simpler.

## Notes

- Related: [adr-workspace-secrets-credential-proxy.md](adr-workspace-secrets-credential-proxy.md), [prd-workspace-internet-access-toggle.md](../../../prd/accepted/prd-workspace-internet-access-toggle.md).
