// The VS Code sign-in: approval in the browser, a one-time code bound to a PKCE challenge, then device
// tokens. Works behind any UI login (basic or any identity-aware proxy); VS Code only calls the API host.
import { AppError } from "@/lib/errors/appError";
import {
  deviceAccessEnabled,
  mintDevice,
  revokeDevice,
  rotateDevice,
  type DeviceTokens,
} from "@/lib/infra/security/credentialStore";
import { CODE_CHALLENGE, CODE_VERIFIER, createConnectCode, redeemConnectCode } from "@/lib/infra/security/connectCodes";

const STATE = /^[A-Za-z0-9_-]{16,128}$/;

export interface ConnectRequest {
  challenge: string;
  state: string;
  /** The port VS Code listens on, on this machine's loopback address, for the one redirect. */
  port: number;
}

interface TokenResponse {
  token_type: "Bearer";
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
}

const invalid = (field: string, message: string) => new AppError("INVALID_REQUEST", message, { field });

const turnedOff = () =>
  new AppError("FORBIDDEN", "VS Code connections are turned off on this instance. Turn them on in Settings.");

/** Checks what VS Code put in the connect URL. Shared by the page (to render) and the authorize route. */
export function parseConnectRequest(input: Record<string, unknown>): ConnectRequest {
  const { code_challenge, code_challenge_method, state } = input;
  if (code_challenge_method !== "S256") throw invalid("code_challenge_method", "code_challenge_method must be S256");
  if (typeof code_challenge !== "string" || !CODE_CHALLENGE.test(code_challenge)) {
    throw invalid("code_challenge", "code_challenge must be an S256 challenge");
  }
  if (typeof state !== "string" || !STATE.test(state)) throw invalid("state", "state is malformed");
  const port = typeof input.port === "string" && /^\d{4,5}$/.test(input.port) ? Number(input.port) : NaN;
  if (!(port >= 1024 && port <= 65535)) throw invalid("port", "port must be between 1024 and 65535");
  return { challenge: code_challenge, state, port };
}

// The loopback redirect of RFC 8252: host and path are fixed here, only the port comes from VS Code, so a
// code can only ever reach a listener on the machine whose browser approved it.
function loopback(request: ConnectRequest, params: Record<string, string>): string {
  const query = new URLSearchParams({ ...params, state: request.state });
  return `http://127.0.0.1:${request.port}/callback?${query}`;
}

/** After the Authorize click: a code for this challenge, sent to VS Code's loopback listener. */
export function authorizeConnect(input: Record<string, unknown>, apiUrl: string): { redirect: string } {
  const request = parseConnectRequest(input);
  if (!deviceAccessEnabled()) throw turnedOff();
  return { redirect: loopback(request, { code: createConnectCode(request.challenge), api: apiUrl }) };
}

/** The Cancel link: tells VS Code to stop waiting, without issuing anything. */
export function denyConnect(request: ConnectRequest): string {
  return loopback(request, { error: "access_denied" });
}

function tokenResponse(tokens: DeviceTokens, now: number): TokenResponse {
  const seconds = (iso: string) => Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
  return {
    token_type: "Bearer",
    access_token: tokens.accessToken,
    expires_in: seconds(tokens.accessExpiresAt),
    refresh_token: tokens.refreshToken,
    refresh_token_expires_in: seconds(tokens.expiresAt),
  };
}

// OAuth's two grants on one endpoint (RFC 6749). Every refusal of a code reads the same, so a caller
// learns nothing about which check failed.
export function exchangeToken(body: Record<string, unknown>, now = Date.now()): TokenResponse {
  if (!deviceAccessEnabled()) throw turnedOff();

  if (body.grant_type === "authorization_code") {
    const { code, code_verifier } = body;
    if (typeof code !== "string" || !code) throw invalid("code", "code is required");
    if (typeof code_verifier !== "string" || !CODE_VERIFIER.test(code_verifier)) {
      throw invalid("code_verifier", "code_verifier is malformed");
    }
    const redeemed = redeemConnectCode(code, code_verifier, () => mintDevice(now), now);
    if (redeemed.status === "reused") revokeDevice(redeemed.deviceId, "connect_code_reused");
    if (redeemed.status !== "ok") throw invalid("code", "The sign-in code is invalid or has expired. Sign in again.");
    return tokenResponse(redeemed.result, now);
  }

  if (body.grant_type === "refresh_token") {
    if (typeof body.refresh_token !== "string") throw invalid("refresh_token", "refresh_token is required");
    const rotation = rotateDevice(body.refresh_token, now);
    if (rotation.ok) return tokenResponse(rotation.tokens, now);
    if (rotation.reason === "disabled") throw turnedOff();
    // Another VS Code window refreshed first: it already saved the new tokens where this one can read them.
    if (rotation.reason === "superseded") {
      throw new AppError("CONFLICT", "This sign-in was refreshed by another window.", { reason: "superseded" });
    }
    throw new AppError("UNAUTHORIZED", "This VS Code sign-in has expired or was revoked. Sign in again.");
  }

  throw invalid("grant_type", 'grant_type must be "authorization_code" or "refresh_token"');
}
