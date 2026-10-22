// Turns a network failure the workspace's own internet settings caused into one plain line for the agent,
// since the proxy's bare 403 or a dead relay never says why.
import type { Workspace } from "../../workspace/types";
import { enforcedDomains, isHostAllowed, NAMED_HOSTS_MAX } from "../../workspace/domain";

export type EgressPolicy = Pick<Workspace, "internetAccess" | "domainAllowlist">;

// The proxy refused the tunnel, so the target was refused even when no blocked host is named.
const REFUSAL_SIGNATURES = [
  /CONNECT tunnel failed/i,
  /Tunnel connection failed/i,
  /tunneling socket could not be established/i,
  /Proxy tunneling failed/i,
  /Proxy response \(403\) !== 200 when HTTP Tunneling/i,
];
// The proxy or relay itself is unreachable: the block while internet is off, maybe an outage otherwise.
const PROXY_DOWN_SIGNATURES = [
  /Could not resolve proxy/i,
  /Unable to connect to (upstream )?proxy/i,
  /127\.0\.0\.1(:| port )3128/,
  /Proxy response \(502\) !== 200 when HTTP Tunneling/i,
];
// Any server can answer these, so they count only with a host the settings refuse.
// `curl -f` words the proxy's 403/502 this way.
const STATUS_SIGNATURES = [/response 403/i, /403\s+Forbidden/i, /returned error: (403|502)\b/i];
// With internet off nothing outside resolves, so these count even when no host is named.
const DNS_SIGNATURES = [
  /Could not resolve host/i,
  /Temporary failure in name resolution/i,
  /\b(ENOTFOUND|EAI_AGAIN)\b/,
];

// URLs (skipping user:pw@ but not an @ in a query), curl's and ssh's DNS errors, and urllib3's `host='…'` (pip).
const HOST_PATTERNS = [
  /\bhttps?:\/\/(?:[^\s/?#@]+@)?([a-z0-9.-]+)/gi,
  /resolve host(?:name)?:? ([a-z0-9.-]*[a-z0-9])/gi,
  /\bhost='([a-z0-9.-]+)'/gi,
];
// The hosts no_proxy sends around the proxy (containerCredentials.ts); every other host goes through it.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/;

type Failure = "refused" | "proxyDown" | "dns" | "status";

function classify(errorText: string): Failure | null {
  const matches = (signatures: RegExp[]) => signatures.some((re) => re.test(errorText));
  if (matches(REFUSAL_SIGNATURES)) return "refused";
  if (matches(PROXY_DOWN_SIGNATURES)) return "proxyDown";
  if (matches(DNS_SIGNATURES)) return "dns";
  return matches(STATUS_SIGNATURES) ? "status" : null;
}

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

// What could not be reached, or "" when the settings did not cause the failure.
// The context (the command or URL) only names hosts, and only when the error itself names none.
function describeTarget(failure: Failure, online: boolean, allowed: string[], errorText: string, context: string) {
  const errorHosts = hostsIn(errorText);
  const hosts = errorHosts.length ? errorHosts : hostsIn(context);
  const blocked = online ? hosts.filter((h) => !isHostAllowed(allowed, h)) : hosts;
  if (blocked.length) {
    // A bare status may be an allowed server's own answer, so a command that also names an allowed host proves nothing.
    if (failure === "status" && !errorHosts.length && blocked.length < hosts.length) return "";
    return `Cannot reach ${blocked.join(", ")}`;
  }
  if (failure === "refused" && online && hosts.length) {
    return `Cannot reach a host outside the allowlist (likely a redirect from ${hosts.join(", ")})`;
  }
  // With no refused host named, only a tunnel refusal, or a dead relay or DNS while offline, is the settings' doing.
  if (failure === "refused" || (!online && failure !== "status")) return "Cannot reach the target";
  return "";
}

function describeLimit(online: boolean, allowed: string[]): string {
  if (!online) return "internet access is off for this workspace";
  if (allowed.length === 0) return "this workspace has no allowed domains";
  if (allowed.length > NAMED_HOSTS_MAX) return `this workspace can only access its ${allowed.length} allowed domains`;
  return `this workspace can only access ${allowed.join(", ")}`;
}

/** The line explaining that `errorText` shows a refusal by the workspace's internet settings, or "" when it doesn't. */
export function egressBlockMessage(policy: EgressPolicy | undefined, errorText: string, context = ""): string {
  if (!policy) return "";
  const failure = classify(errorText);
  if (!failure) return "";
  // A workspace saved before the field existed is online, as in buildTools and the prompt.
  const online = policy.internetAccess ?? true;
  const allowed = online ? enforcedDomains(policy.domainAllowlist) : [];
  if (allowed === null) return "";
  const target = describeTarget(failure, online, allowed, errorText, context);
  return target ? `${target}: ${describeLimit(online, allowed)}.` : "";
}
