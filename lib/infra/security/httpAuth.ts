// Auth and CSRF logic for the server gates (lib/infra/server/), kept apart so it is unit-testable.
// How a browser proves identity is uiAuth.ts's job; this only consumes a UiAuthenticator.
import type { IncomingMessage } from "http";
import { isPlatformRouteAllowed } from "./platformAccessPolicy";
import { isLoopbackAddress } from "./rateLimit";
import { runtimeMode } from "../runtimeMode";
import type { UiAuthenticator } from "./uiAuth";

// Tracks per-IP credential failures and blocks an IP once it exceeds `max` failures within
// `windowMs`. In-memory, reset when the window elapses. A successful auth clears the IP.
export class AuthFailureTracker {
  private failures = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max = 5,
    private windowMs = 60_000,
  ) {}

  isBlocked(ip: string): boolean {
    const entry = this.failures.get(ip);
    if (!entry || Date.now() > entry.resetAt) return false;
    return entry.count >= this.max;
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    const entry = this.failures.get(ip);
    if (!entry || now > entry.resetAt) {
      this.failures.set(ip, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count++;
    }
  }

  clear(ip: string): void {
    this.failures.delete(ip);
  }
}

// The agent run and stop endpoints authenticate via Bearer API key, not Basic Auth — exempt POSTs.
const PUBLIC_API_RE = /^\/api\/workspaces\/[^/]+\/agent(?:\/stop)?$/;
// Workspace MCP authenticates with its own Bearer key, so it is exempt from Basic Auth. GET/DELETE carry no
// secret and get 405 before touching state.
const PUBLIC_MCP_RE = /^\/api\/workspaces\/[^/]+\/mcp$/;
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// "ok": UI credential verified (the only result that may mint a session cookie). "platform": instance token
// verified for this method/path; "forbidden": verified, route not shared. "exempt": route checks its own.
export type AuthResult = "ok" | "platform" | "exempt" | "challenge" | "unauthorized" | "forbidden" | "blocked";
// Takes only the secret: the platform credential is instance-wide, and the route allowlist decides
// what it may reach.
export type PlatformTokenValidator = (plain: string) => boolean;

type RequestHostHeaders = {
  host?: string | string[];
  "x-forwarded-host"?: string | string[];
};

export type RequestHostValidation =
  | { ok: true; hostname: string }
  | {
      ok: false;
      reason: "host_missing" | "host_malformed" | "host_untrusted" | "forwarded_host_malformed" | "host_mismatch";
    };

// Ports are ignored: the hostname is the security boundary. URL parsing canonicalizes case, trailing
// dots, IDNs and IPv6 brackets while rejecting paths, credentials and header lists.
function normalizeHostname(value: string): string | null {
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.includes(",") ||
    /[\s/@\\?#]/.test(candidate) ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    return null;
  }
  try {
    const parsed = new URL(`http://${candidate}`);
    if (!parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/") return null;
    return parsed.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
  } catch {
    return null;
  }
}

function singleHeader(value: string | string[] | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value;
}

type TrustedHostEnvironment = {
  PAODO_TRUSTED_HOSTS?: string;
  WORKSPACE_API_DOMAIN?: string;
};

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function normalizeAll(configured: readonly string[], label: string): Set<string> {
  const normalized = new Set<string>();
  for (const host of configured) {
    const hostname = normalizeHostname(host);
    if (!hostname) throw new Error(`invalid ${label}: ${JSON.stringify(host)}`);
    normalized.add(hostname);
  }
  return normalized;
}

function publicUiHosts(env: TrustedHostEnvironment): string[] {
  const raw = env.PAODO_TRUSTED_HOSTS?.trim();
  return raw ? raw.split(",").map((host) => host.trim()) : [];
}

/** Build the deployment's hostname allowlist. A malformed configured hostname is a startup error. */
export function trustedRequestHosts(
  env: TrustedHostEnvironment = {
    PAODO_TRUSTED_HOSTS: process.env.PAODO_TRUSTED_HOSTS,
    WORKSPACE_API_DOMAIN: process.env.WORKSPACE_API_DOMAIN,
  },
): ReadonlySet<string> {
  const configured = [...LOOPBACK_HOSTS, "app", ...publicUiHosts(env)];
  if (env.WORKSPACE_API_DOMAIN?.trim()) configured.push(env.WORKSPACE_API_DOMAIN.trim());
  return normalizeAll(configured, "trusted hostname");
}

// Hostnames a /ws handshake may come from. Not trustedRequestHosts: loopback and "app" have to be
// trusted as a Host but never as an origin, or any local page opens an authenticated socket.
export function trustedRequestOrigins(
  env: TrustedHostEnvironment = { PAODO_TRUSTED_HOSTS: process.env.PAODO_TRUSTED_HOSTS },
  dev = runtimeMode.hotReload,
): ReadonlySet<string> {
  // Loopback only while no public hostname is declared: declaring one is the edit validateRequestHost
  // already forced, so the safe set needs no second step. NODE_ENV can't tell — compose builds prod.
  const declared = publicUiHosts(env);
  const configured = dev || declared.length === 0 ? [...declared, ...LOOPBACK_HOSTS] : declared;
  return normalizeAll(configured, "trusted origin hostname");
}

// The API/MCP gateway hostname, or null when there is none. The UI credential is refused on it, and a
// malformed value is a startup error.
export function apiRequestHost(
  env: { WORKSPACE_API_DOMAIN?: string } = { WORKSPACE_API_DOMAIN: process.env.WORKSPACE_API_DOMAIN },
): string | null {
  const configured = env.WORKSPACE_API_DOMAIN?.trim();
  if (!configured) return null;
  const hostname = normalizeHostname(configured);
  if (!hostname) throw new Error(`invalid WORKSPACE_API_DOMAIN: ${JSON.stringify(configured)}`);
  return hostname;
}

// Reject Host-header poisoning before authentication or Next.js routing. A proxy may omit
// X-Forwarded-Host; if it sends one, it must be one canonical value and agree with Host.
export function validateRequestHost(
  headers: RequestHostHeaders,
  trustedHosts: ReadonlySet<string>,
): RequestHostValidation {
  const rawHost = singleHeader(headers.host);
  if (rawHost === undefined) return { ok: false, reason: "host_missing" };
  if (rawHost === null) return { ok: false, reason: "host_malformed" };
  const hostname = normalizeHostname(rawHost);
  if (!hostname) return { ok: false, reason: "host_malformed" };
  if (!trustedHosts.has(hostname)) return { ok: false, reason: "host_untrusted" };

  const rawForwardedHost = singleHeader(headers["x-forwarded-host"]);
  if (rawForwardedHost === null) return { ok: false, reason: "forwarded_host_malformed" };
  if (rawForwardedHost !== undefined) {
    const forwardedHostname = normalizeHostname(rawForwardedHost);
    if (!forwardedHostname) return { ok: false, reason: "forwarded_host_malformed" };
    if (forwardedHostname !== hostname || !trustedHosts.has(forwardedHostname)) {
      return { ok: false, reason: "host_mismatch" };
    }
  }
  return { ok: true, hostname };
}

// Handshakes skip the same-origin policy, so without this any site could read a live session. Takes
// trustedRequestOrigins; a missing or `null` Origin is refused, since only browsers connect to /ws.
export function validateRequestOrigin(
  origin: string | string[] | undefined,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  const raw = singleHeader(origin);
  if (!raw) return false;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  const hostname = normalizeHostname(parsed.host);
  return hostname !== null && trustedOrigins.has(hostname);
}

// Plain-object view of a request, so the auth logic is testable without Node's http types.
export type AuthRequest = {
  method: string;
  pathname: string;
  authorization: string;
  cookie: string;
  /** Raw value of the header the UI mode reads; empty in modes that read none. */
  assertion: string;
  /** Already-validated host, used to refuse the UI credential on the API gateway host. */
  hostname: string;
  /** The /ws handshake: the one request that may fall back to a cookie (see uiAuth.ts). */
  isUpgrade: boolean;
};

// A repeated assertion header is treated as absent. Node joins duplicates into one comma-separated
// value (only set-cookie becomes an array), and a JWS holds no comma — either shape means two senders.
function singleAssertion(value: string | string[] | undefined): string {
  if (typeof value !== "string" || value.includes(",")) return "";
  return value;
}

export function authRequestFromIncoming(
  req: IncomingMessage,
  assertionHeader: string | null = null,
  hostname = "",
  isUpgrade = false,
): AuthRequest {
  const url = new URL(req.url ?? "/", "http://localhost");
  return {
    method: req.method ?? "GET",
    pathname: url.pathname,
    authorization: req.headers["authorization"] ?? "",
    cookie: req.headers["cookie"] ?? "",
    assertion: assertionHeader ? singleAssertion(req.headers[assertionHeader]) : "",
    hostname,
    isUpgrade,
  };
}

// Keys the audit trail and lockout, so only cf-connecting-ip is read: every front hop must overwrite it
// (Cloudflare, Caddyfile). Loopback is refused since the limiter exempts it; falls back to the socket.
export function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers["cf-connecting-ip"];
  if (typeof forwarded === "string" && forwarded.trim() && !isLoopbackAddress(forwarded.trim())) {
    return forwarded;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function checkAuth(
  ip: string,
  req: AuthRequest,
  ui: UiAuthenticator,
  tracker: AuthFailureTracker,
  validatePlatformToken: PlatformTokenValidator = () => false,
  apiHost: string | null = null,
): AuthResult {
  if (tracker.isBlocked(ip)) return "blocked";

  // The agent endpoint authenticates via Bearer API key — exempt it from the UI credential.
  if (req.method === "POST" && PUBLIC_API_RE.test(req.pathname)) return "exempt";
  // The Workspace MCP endpoint authenticates via its own Bearer secret — exempt all methods.
  if (PUBLIC_MCP_RE.test(req.pathname)) return "exempt";

  const auth = req.authorization;
  if (auth.startsWith("Bearer ")) {
    const token = auth.slice(7);

    // Authentication first, and it is the only thing that feeds the brute-force tracker: a bad secret
    // is a credential guess.
    if (!validatePlatformToken(token)) {
      tracker.recordFailure(ip);
      return "unauthorized";
    }

    // Default-deny, and not counted as a failure: the tracker is shared with the UI login, so a script polling an
    // unmapped route would lock its operator out.
    if (!isPlatformRouteAllowed(req.method, req.pathname)) return "forbidden";

    tracker.clear(ip);
    return "platform";
  }

  // The shared UI credential is the browser front door only; on the public API host the exempt and
  // platform paths above are the sole identities. Untracked: all api.* traffic shares one gateway IP.
  if (apiHost && req.hostname === apiHost) return "unauthorized";

  const outcome = ui.verify(req);
  // "absent" is the normal unauthenticated first request, not an attack, so it never counts toward
  // the lockout — only a credential that was offered and rejected does.
  if (outcome === "absent") return "challenge";
  if (outcome === "invalid") {
    tracker.recordFailure(ip);
    return "unauthorized";
  }

  tracker.clear(ip);
  return "ok";
}

// Tries the UI mode first so failures feed the tracker, then the session cookie WebKit needs since it
// won't resend Basic on upgrade (iap passes a never-true verifier). Platform and exempt are HTTP-only.
export function checkWsAuth(
  ip: string,
  req: AuthRequest,
  ui: UiAuthenticator,
  tracker: AuthFailureTracker,
  verifyCookie: (cookieHeader: string) => boolean,
  apiHost: string | null = null,
): AuthResult {
  const result = checkAuth(ip, req, ui, tracker, () => false, apiHost);
  if (result === "ok" || result === "blocked") return result;
  // The session cookie is a basic-mode UI credential too, so it is refused on the API host alongside
  // the password checkAuth already rejected above.
  if (apiHost && req.hostname === apiHost) return result;
  return verifyCookie(req.cookie) ? "ok" : result;
}

// CSRF: browsers send Sec-Fetch-Site and attach cached Basic Auth cross-origin, so cross-site mutations are
// refused. Requests without the header (non-browser) pass.
export function isCsrf(req: { method: string; pathname: string; secFetchSite: string | undefined }): boolean {
  if (!MUTATING_METHODS.has(req.method)) return false;
  if (!req.pathname.startsWith("/api/")) return false;
  const site = req.secFetchSite;
  if (typeof site !== "string") return false; // non-browser client
  return site !== "same-origin" && site !== "none";
}
