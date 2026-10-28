# ADR — Per-workspace internet access on/off toggle

Status: Accepted

## Context

Some workspaces must never reach the internet, so that no prompt injection or agent misbehavior can turn them into a way to send data out or fetch instructions in. An instruction in the prompt or a hidden tool is not a boundary: the guarantee has to hold even if the model is fully compromised.

## Decision

"Off" is enforced at the network level; every other layer is defense in depth on top of it.

1. **Network (the boundary).** Every workspace sits on its own `--internal` Docker network, whatever the setting, so its only path out is the credential-proxy sidecar. Internet on means the sidecar is attached to that network; off means it is detached, and detachment is confirmed. With the sidecar gone, the container has no route out at all.
2. **Proxy policy.** The proxy also keeps a per-workspace policy file and refuses any connection from a workspace marked off, in case the sidecar were ever wrongly attached.
3. **Tools.** When off, `http_get` and `apt_install` are not given to the agent, and secret tokens are not passed into the container.
4. **Prompt.** The agent's system prompt states that internet is off, so it does not waste turns retrying commands that cannot succeed.

`http_get` runs inside the container through the proxy like any other command, so it is subject to the same network boundary and the proxy's destination checks.

The setting is applied to the running container without restarting it. The registry, the proxy policy and the sidecar attachment are updated together, and all three roll back if any step fails. Every container wake re-checks the attachment, so a half-applied change heals itself. New workspaces start with internet off; a missing or unreadable workspace record is treated as off.

## Consequences

- The guarantee holds against a fully compromised model: no tool or shell command can open a connection out of an off workspace.
- Toggling takes effect immediately, mid-session, without losing the container.
- Off does not cover non-internet channels: attached drives and agent-to-agent calls still work, so an off workspace can still receive untrusted text through them; it just cannot reach out.
- While on, access can be narrowed further to specific hosts (see [adr-workspace-domain-allowlist.md](adr-workspace-domain-allowlist.md)).

## Alternatives considered

- **Filter traffic instead of removing the route**: "off" would then depend on trusting a filter to catch everything a compromised agent might try.
- **Hide the network tools only**: `execute_command` is a full shell, so `curl` or `wget` would still work.
- **Block in the proxy only, sidecar still attached**: a workspace that can reach the proxy is one proxy bug away from leaking.

## Notes

- Related: [adr-container-per-workspace-sandbox.md](adr-container-per-workspace-sandbox.md), [adr-workspace-secrets-credential-proxy.md](adr-workspace-secrets-credential-proxy.md), [prd-workspace-internet-access-toggle.md](../../../prd/accepted/prd-workspace-internet-access-toggle.md).
