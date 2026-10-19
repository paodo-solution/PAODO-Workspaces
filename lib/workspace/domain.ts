// Domain format shared by secrets' allowed domains and the internet allowlist. Pure, so the browser
// checks a domain with the same rule the server enforces.
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

/** The hosts actually enforced, or null when unrestricted: an empty list doesn't restrict anything yet. */
export function enforcedDomains(allowlist: DomainAllowlist | undefined): string[] | null {
  return allowlist?.restricted && allowlist.domains.length > 0 ? allowlist.domains : null;
}

/** Shape check for an allowlist read off disk or the wire; domain format is checked separately. */
export function isDomainAllowlist(value: unknown): value is DomainAllowlist {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { restricted, domains } = value as Record<string, unknown>;
  return typeof restricted === "boolean" && Array.isArray(domains) && domains.every((d) => typeof d === "string");
}
