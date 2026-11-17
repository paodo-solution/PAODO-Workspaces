// The surface a VS Code device token can reach. Widening it is a deliberate, reviewed change to this snapshot.
import { expect, it } from "vitest";
import { deviceRouteRules, isDeviceRouteAllowed } from "./deviceAccessPolicy";

const CONV = "b6b8b4f1-0000-4000-8000-000000000000";

it("pins the device routes", () => {
  expect(deviceRouteRules()).toMatchInlineSnapshot(`
    [
      "GET ^\\/api\\/connect\\/session$",
      "DELETE ^\\/api\\/connect\\/session$",
      "GET ^\\/api\\/connect\\/events$",
      "GET ^\\/api\\/workspaces$",
      "GET ^\\/api\\/workspaces\\/[^/]+\\/conversations$",
      "POST ^\\/api\\/workspaces\\/[^/]+\\/conversations$",
      "GET ^\\/api\\/workspaces\\/[^/]+\\/conversations\\/[0-9a-f-]+$",
      "POST ^\\/api\\/workspaces\\/[^/]+\\/chat$",
      "POST ^\\/api\\/workspaces\\/[^/]+\\/conversations\\/[0-9a-f-]+\\/stop$",
    ]
  `);
});

it("refuses admin, settings and token-minting routes", () => {
  expect(isDeviceRouteAllowed("GET", "/connect/vscode")).toBe(false);
  expect(isDeviceRouteAllowed("GET", "/api/settings/vscode-access")).toBe(false);
  expect(isDeviceRouteAllowed("DELETE", "/api/workspaces/x")).toBe(false);
  expect(isDeviceRouteAllowed("POST", "/api/workspaces")).toBe(false);
  expect(isDeviceRouteAllowed("GET", "/api/workspaces/x")).toBe(false);
  expect(isDeviceRouteAllowed("GET", "/api/connect/session/x")).toBe(false);
  expect(isDeviceRouteAllowed("POST", "/api/connect/events")).toBe(false);
  expect(isDeviceRouteAllowed("POST", "/api/workspaces/x/conversations/initial")).toBe(false);
  expect(isDeviceRouteAllowed("GET", "/api/workspaces/x/conversations/c1/sessions")).toBe(false);
  expect(isDeviceRouteAllowed("GET", "/api/workspaces/x/conversations/initial")).toBe(false);
  expect(isDeviceRouteAllowed("GET", `/api/workspaces/x/conversations/${CONV}/sessions`)).toBe(false);
  expect(isDeviceRouteAllowed("POST", "/api/workspaces/x/agent")).toBe(false);
  expect(isDeviceRouteAllowed("POST", "/api/workspaces/x/agent/stop")).toBe(false);
});

it("takes only a lowercase hex id as the conversation id", () => {
  expect(isDeviceRouteAllowed("GET", `/api/workspaces/x/conversations/${CONV}`)).toBe(true);
  expect(isDeviceRouteAllowed("GET", "/api/workspaces/x/conversations/x1")).toBe(false);
  expect(isDeviceRouteAllowed("GET", `/api/workspaces/x/conversations/${CONV.toUpperCase()}`)).toBe(false);
  expect(isDeviceRouteAllowed("POST", "/api/workspaces/x/conversations/initial/stop")).toBe(false);
});

it("matches exactly one segment for the workspace id", () => {
  expect(isDeviceRouteAllowed("GET", "/api/workspaces//conversations")).toBe(false);
  expect(isDeviceRouteAllowed("GET", "/api/workspaces/a/b/conversations")).toBe(false);
});

// Every allowed route, then every near-miss of it: another method, or a path one edit away. A loosened regex
// (a missing anchor, an optional slash, a case-insensitive flag) lets one of these through and fails here.
it("allows each route exactly, and refuses every near-miss of it", () => {
  const allowed = [
    ["GET", "/api/connect/session"],
    ["DELETE", "/api/connect/session"],
    ["GET", "/api/connect/events"],
    ["GET", "/api/workspaces"],
    ["GET", "/api/workspaces/w1/conversations"],
    ["POST", "/api/workspaces/w1/conversations"],
    ["GET", `/api/workspaces/w1/conversations/${CONV}`],
    ["POST", "/api/workspaces/w1/chat"],
    ["POST", `/api/workspaces/w1/conversations/${CONV}/stop`],
  ] as const;
  const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "get"];
  const nearPaths = (path: string) => [
    `${path}/`,
    `${path}/x`,
    `${path}x`,
    `${path}?x`,
    `${path}.json`,
    `/x${path}`,
    `/${path}`,
    path.replace("/api/", "/api//"),
    path.toUpperCase(),
    path.replace(/\/[^/]+$/, ""),
  ];
  const isAllowed = (method: string, path: string) => allowed.some(([m, p]) => m === method && p === path);

  for (const [method, path] of allowed) {
    expect(isDeviceRouteAllowed(method, path), `${method} ${path}`).toBe(true);
    for (const other of methods) {
      if (!isAllowed(other, path)) expect(isDeviceRouteAllowed(other, path), `${other} ${path}`).toBe(false);
    }
    for (const near of nearPaths(path)) {
      for (const other of methods) {
        if (!isAllowed(other, near)) expect(isDeviceRouteAllowed(other, near), `${other} ${near}`).toBe(false);
      }
    }
  }
});
