// One-time codes for the VS Code sign-in (OAuth code flow with PKCE, S256 only). In memory, like the app's
// other short-lived state: a restart only drops sign-ins that were mid-way, and those time out in 60 s.
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { globalSingleton } from "../globalSingleton";

export const CONNECT_CODE_TTL_MS = 60_000;
// Codes are minted only behind the UI login, so this only bounds a runaway tab, not an attacker.
const MAX_PENDING = 1000;

/** RFC 7636: 43 to 128 unreserved characters; S256 challenges are always 43 base64url characters. */
export const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;
export const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

interface PendingCode {
  challenge: string;
  expiresAt: number;
  /** Set once redeemed: a second redemption is an intercepted code, and revokes what the first produced. */
  deviceId: string | null;
}

type Redemption<T> = { status: "ok"; result: T } | { status: "invalid" } | { status: "reused"; deviceId: string };

const pending = globalSingleton("connectCodes", () => new Map<string, PendingCode>());

const sha256 = (value: string) => createHash("sha256").update(value).digest();

export function s256(verifier: string): string {
  return sha256(verifier).toString("base64url");
}

function prune(now: number): void {
  for (const [hash, code] of pending) if (now >= code.expiresAt) pending.delete(hash);
}

/** Mints a single-use code bound to the client's PKCE challenge. Only its hash is kept. */
export function createConnectCode(challenge: string, now = Date.now()): string {
  prune(now);
  if (pending.size >= MAX_PENDING) throw new Error("Too many pending VS Code sign-ins.");
  const code = randomBytes(32).toString("base64url");
  pending.set(sha256(code).toString("hex"), { challenge, expiresAt: now + CONNECT_CODE_TTL_MS, deviceId: null });
  return code;
}

// Every failure looks the same to the caller. A wrong verifier burns the code, so it cannot be guessed at;
// `issue` runs only for the one valid redemption, and its device id is remembered for reuse detection.
export function redeemConnectCode<T extends { deviceId: string }>(
  code: string,
  verifier: string,
  issue: () => T,
  now = Date.now(),
): Redemption<T> {
  prune(now);
  const key = sha256(code).toString("hex");
  const entry = pending.get(key);
  if (!entry) return { status: "invalid" };
  if (entry.deviceId) {
    pending.delete(key);
    return { status: "reused", deviceId: entry.deviceId };
  }
  const presented = Buffer.from(CODE_VERIFIER.test(verifier) ? s256(verifier) : "");
  const expected = Buffer.from(entry.challenge);
  if (presented.byteLength !== expected.byteLength || !timingSafeEqual(presented, expected)) {
    pending.delete(key);
    return { status: "invalid" };
  }
  const result = issue();
  entry.deviceId = result.deviceId;
  return { status: "ok", result };
}
