// Domain format shared by secrets' allowed domains and the internet allowlist. Pure, so the browser
// checks a domain with the same rule the server enforces.

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
