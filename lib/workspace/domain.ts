// Domain format and host matching shared by secrets, the internet allowlist and the proxy. Pure, so the
// browser checks a domain with the same rule the server enforces.
import type { DomainAllowlist } from "./types";

const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/** The UI's message for a domain `isValidDomain` refuses. */
export const DOMAIN_FORMAT_ERROR = "Enter a domain like api.openai.com";

/** Reduces input to a bare hostname: strips scheme, path, port and trailing dot, e.g. "https://API.x.com/v1" → "api.x.com". */
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

/** True when `input` normalizes to a public hostname (no IP, no single label like "localhost"). */
export function isValidDomain(input: string): boolean {
  return DOMAIN_RE.test(normalizeDomain(input));
}

/** The hosts actually enforced, or null when unrestricted: a restricted empty list allows no host at all. */
export function enforcedDomains(allowlist: DomainAllowlist | undefined): string[] | null {
  return allowlist?.restricted ? allowlist.domains : null;
}

/** The UI's line for a restriction with no domain; the update's warning for it starts with it. */
export const NO_ALLOWED_DOMAIN = "No allowed domain is set";

const BLOCKS_EVERY_HOST = `${NO_ALLOWED_DOMAIN}: domainRestriction blocks every host until one is added`;
const SAVED_OFFLINE = "internetAccess is false: the allowlist is saved and applies once internetAccess is true";
/** Above this, the warning counts the reachable hosts instead of naming them. */
export const NAMED_HOSTS_MAX = 10;

/** The egress fields an update sent, each undefined when left out. */
export interface EgressFieldsSent {
  internetAccess?: boolean;
  domainRestriction?: boolean;
  allowedDomains?: string[];
}

/**
 * The update receipt's warning: what the workspace can reach afterwards, whenever the fields the update
 * sent suggest otherwise. A field sent in the same update needs no explaining; one already saved may,
 * since the read hides a list while it is not enforced.
 */
export function egressWarning(
  internetAccess: boolean,
  allowlist: DomainAllowlist | undefined,
  sent: EgressFieldsSent,
): string | undefined {
  const enforced = enforcedDomains(allowlist);
  const sentAllowlist = sent.domainRestriction !== undefined || sent.allowedDomains !== undefined;
  if (!internetAccess) {
    if (!sentAllowlist) return undefined;
    return enforced?.length === 0
      ? `${SAVED_OFFLINE}, and with no allowed domain it will then block every host`
      : SAVED_OFFLINE;
  }
  if (enforced === null || (!sentAllowlist && sent.internetAccess === undefined)) return undefined;
  if (enforced.length === 0) return BLOCKS_EVERY_HOST;
  return sent.allowedDomains === undefined
    ? `domainRestriction is on: only ${reachableHosts(enforced)} reachable`
    : undefined;
}

function reachableHosts(domains: string[]): string {
  if (domains.length > NAMED_HOSTS_MAX) return `the ${domains.length} allowedDomains are`;
  return `${domains.join(", ")} ${domains.length === 1 ? "is" : "are"}`;
}

// Exact host only: a key for "api.openai.com" must never reach another "*.openai.com" host.
export function hostMatches(hostname: string, domain: string): boolean {
  return hostname.toLowerCase() === domain.toLowerCase();
}

// Exact match, like secrets: "vercel.com" doesn't cover "api.vercel.com". Unrestricted workspaces pass.
export function isHostAllowed(allowed: readonly string[] | null, hostname: string): boolean {
  if (allowed === null) return true;
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return allowed.some((domain) => hostMatches(host, domain));
}

/** A secret's hosts the allowlist refuses; empty when nothing is enforced. */
export function blockedHosts(secretDomains: string[], allowlist: DomainAllowlist | undefined): string[] {
  const allowed = enforcedDomains(allowlist);
  return secretDomains.filter((d) => !isHostAllowed(allowed, d));
}

/** Shape check for an allowlist read off disk or the wire; domain format is checked separately. */
export function isDomainAllowlist(value: unknown): value is DomainAllowlist {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { restricted, domains } = value as Record<string, unknown>;
  return typeof restricted === "boolean" && Array.isArray(domains) && domains.every((d) => typeof d === "string");
}
