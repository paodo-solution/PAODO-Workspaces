// Turns a network failure the workspace's own internet settings caused into one plain line for the agent,
// since the proxy's bare 403 or a dead relay never says why.
import type { Workspace } from "../../workspace/types";
import { enforcedDomains, isHostAllowed } from "../../workspace/domain";

export type EgressPolicy = Pick<Workspace, "internetAccess" | "domainAllowlist">;

// What curl, git, pip, npm and Node print when the proxy refuses a host or the relay has no way out.
const BLOCK_SIGNATURES = [
  /response 403/i,
  /403\s+Forbidden/i,
  /CONNECT tunnel failed/i,
  /Tunnel connection failed/i,
  /tunneling socket could not be established/i,
  /Could not resolve proxy/i,
  /Unable to connect to (upstream )?proxy/i,
  /127\.0\.0\.1(:| port )3128/,
  /Could not resolve host/i,
  /Temporary failure in name resolution/i,
  /\b(ENOTFOUND|EAI_AGAIN)\b/,
];

// URLs, curl's DNS error, and urllib3's `host='…'` (pip).
const HOST_PATTERNS = [/\bhttps?:\/\/([a-z0-9.-]+)/gi, /resolve host: ([a-z0-9.-]+)/gi, /\bhost='([a-z0-9.-]+)'/gi];
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/;

function hostsIn(text: string): string[] {
  const hosts = new Set<string>();
  for (const re of HOST_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const host = m[1].toLowerCase().replace(/\.$/, "");
      if (host && !LOCAL_HOST.test(host)) hosts.add(host);
    }
  }
  return [...hosts];
}

/** The line explaining that `text` failed because of the workspace's internet settings, or "" when it didn't. */
export function egressBlockMessage(policy: EgressPolicy | undefined, text: string): string {
  if (!policy || !BLOCK_SIGNATURES.some((re) => re.test(text))) return "";
  const allowed = policy.internetAccess ? enforcedDomains(policy.domainAllowlist) : [];
  if (allowed === null) return "";
  const hosts = hostsIn(text);
  // An allowed host that failed (its own 403, a typo'd path) is not the allowlist's doing.
  const blocked = policy.internetAccess ? hosts.filter((h) => !isHostAllowed(allowed, h)) : hosts;
  if (policy.internetAccess && hosts.length > 0 && blocked.length === 0) return "";
  const target = blocked.length ? `Cannot reach ${blocked.join(", ")}` : "Cannot reach the target";
  if (!policy.internetAccess) return `${target}: internet access is off for this workspace.`;
  if (allowed.length === 0) return `${target}: this workspace has no allowed domains.`;
  return `${target}: this workspace can only access ${allowed.join(", ")}.`;
}
