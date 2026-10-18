// Signed cookie that authenticates the /ws handshake in `basic` mode (Safari won't reuse Basic credentials
// on upgrades). Never accepted for HTTP; SameSite=Strict, expiry only, key random per boot (never on disk).
import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { readCookie } from "./cookies";

export const SESSION_COOKIE_NAME = "paodo_ws_session";

const TTL_MS = 12 * 60 * 60 * 1000;
// Re-mint near expiry so an open tab's socket survives, without setting the cookie on every response.
const REFRESH_BEFORE_MS = 60 * 60 * 1000;

let sessionKey: Buffer | null = null;

function getKey(): Buffer {
  if (!sessionKey) sessionKey = randomBytes(32);
  return sessionKey;
}

function sign(payload: string): string {
  return createHmac("sha256", getKey()).update(payload).digest("hex");
}

export type SessionCookieOptions = { isProduction: boolean };

// Builds the Set-Cookie value. `Secure` is gated on isProduction for the same reason
// securityHeaders.ts gates HSTS: dev runs over plain http and the browser would drop the cookie.
export function mintSessionCookie(opts: SessionCookieOptions): string {
  const exp = String(Date.now() + TTL_MS);
  const attrs = [
    `${SESSION_COOKIE_NAME}=${exp}.${sign(exp)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (opts.isProduction) attrs.push("Secure");
  return attrs.join("; ");
}

// Expiry if the cookie verifies and is unexpired; null for every malformed shape, so callers fail closed.
export function sessionExpiry(cookieHeader: string | undefined): number | null {
  const raw = readCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (!raw) return null;

  const dot = raw.indexOf(".");
  if (dot === -1) return null;
  const payload = raw.slice(0, dot);
  const presented = raw.slice(dot + 1);

  // Verify before trusting the payload for anything, including the expiry comparison below.
  const expected = Buffer.from(sign(payload), "latin1");
  const got = Buffer.from(presented, "latin1");
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return null;

  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  return exp;
}

export function verifySessionCookie(cookieHeader: string | undefined): boolean {
  return sessionExpiry(cookieHeader) !== null;
}

export function sessionCookieNeedsRefresh(cookieHeader: string | undefined): boolean {
  const exp = sessionExpiry(cookieHeader);
  return exp === null || exp - Date.now() < REFRESH_BEFORE_MS;
}
