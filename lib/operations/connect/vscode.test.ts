// The VS Code sign-in end to end, below HTTP: Allow → code → tokens → refresh, and every refusal.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";

const { ROOT } = vi.hoisted(() => {
  const os = require("os");
  const fs = require("fs");
  const path = require("path");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "connect-vscode-test-"));
  process.env.WORKSPACES_ROOT = root;
  return { ROOT: root };
});

vi.mock("@/lib/infra/logger", () => ({
  createLogger: () => ({ error: () => {}, warn: () => {}, info: () => {}, debug: () => {} }),
  createAuditLogger: () => ({ info: () => {} }),
}));

import { AppError } from "@/lib/errors/appError";
import { s256 } from "@/lib/infra/security/connectCodes";
import { setEnabled, validateDeviceAccess } from "@/lib/infra/security/credentialStore";
import { authorizeConnect, denyConnect, exchangeToken, parseConnectRequest } from "./vscode";

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const VERIFIER = "x".repeat(43);
const API = "https://api.example.com";
const request = (overrides: Record<string, unknown> = {}) => ({
  code_challenge: s256(VERIFIER),
  code_challenge_method: "S256",
  state: "s".repeat(32),
  port: "54321",
  ...overrides,
});

function codeFrom(redirect: string): string {
  return new URL(redirect).searchParams.get("code")!;
}

function errorOf(fn: () => unknown): AppError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AppError) return err;
    throw err;
  }
  throw new Error("expected an AppError");
}

beforeEach(() => setEnabled("device", null, true));

describe("VS Code sign-in", () => {
  it("redirects only to the loopback callback, with the code, the state and the API URL", () => {
    const url = new URL(authorizeConnect(request(), API).redirect);
    expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("http://127.0.0.1:54321/callback");
    expect(url.searchParams.get("state")).toBe("s".repeat(32));
    expect(url.searchParams.get("api")).toBe(API);
    expect(url.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("cancels through the same callback, issuing nothing", () => {
    const url = new URL(denyConnect(parseConnectRequest(request())));
    expect(url.host).toBe("127.0.0.1:54321");
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.has("code")).toBe(false);
  });

  it("refuses anything but S256, a malformed state or a bad port", () => {
    for (const bad of [
      { code_challenge_method: "plain" },
      { code_challenge: "short" },
      { state: "x" },
      { port: "80" },
      { port: "70000" },
      { port: "1234@evil.com" },
      { port: undefined },
    ]) {
      expect(errorOf(() => parseConnectRequest(request(bad))).code).toBe("INVALID_REQUEST");
    }
  });

  it("exchanges a code for tokens, then refreshes them", () => {
    const code = codeFrom(authorizeConnect(request(), API).redirect);
    const tokens = exchangeToken({ grant_type: "authorization_code", code, code_verifier: VERIFIER });
    expect(tokens).toMatchObject({ token_type: "Bearer" });
    expect(tokens).not.toHaveProperty("device");
    expect(tokens.expires_in).toBe(8 * 60 * 60);
    expect(tokens.refresh_token_expires_in).toBe(30 * 24 * 60 * 60);
    const deviceId = validateDeviceAccess(tokens.access_token);
    expect(deviceId).toMatch(/^[0-9a-f]{16}$/);

    const refreshed = exchangeToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token });
    expect(validateDeviceAccess(refreshed.access_token)).toBe(deviceId);
    expect(validateDeviceAccess(tokens.access_token)).toBeNull();
    expect(
      errorOf(() => exchangeToken({ grant_type: "refresh_token", refresh_token: tokens.refresh_token })).details,
    ).toEqual({
      reason: "superseded",
    });
  });

  it("revokes the device when its code is replayed", () => {
    const code = codeFrom(authorizeConnect(request(), API).redirect);
    const tokens = exchangeToken({ grant_type: "authorization_code", code, code_verifier: VERIFIER });
    const replay = errorOf(() => exchangeToken({ grant_type: "authorization_code", code, code_verifier: VERIFIER }));
    expect(replay.code).toBe("INVALID_REQUEST");
    expect(validateDeviceAccess(tokens.access_token)).toBeNull();
  });

  it("refuses a wrong verifier, an unknown grant and a dead refresh token", () => {
    const code = codeFrom(authorizeConnect(request(), API).redirect);
    expect(
      errorOf(() => exchangeToken({ grant_type: "authorization_code", code, code_verifier: "y".repeat(43) })).code,
    ).toBe("INVALID_REQUEST");
    expect(errorOf(() => exchangeToken({ grant_type: "password" })).code).toBe("INVALID_REQUEST");
    expect(
      errorOf(() =>
        exchangeToken({ grant_type: "refresh_token", refresh_token: `drt_${"0".repeat(16)}_${"0".repeat(64)}` }),
      ).code,
    ).toBe("UNAUTHORIZED");
  });

  it("refuses to approve or exchange while VS Code connections are off", () => {
    const code = codeFrom(authorizeConnect(request(), API).redirect);
    setEnabled("device", null, false);
    expect(errorOf(() => authorizeConnect(request(), API)).code).toBe("FORBIDDEN");
    expect(errorOf(() => exchangeToken({ grant_type: "authorization_code", code, code_verifier: VERIFIER })).code).toBe(
      "FORBIDDEN",
    );
  });
});
