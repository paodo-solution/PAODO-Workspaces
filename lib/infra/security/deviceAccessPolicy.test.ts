// The surface a VS Code device token can reach. Widening it is a deliberate, reviewed change to this snapshot.
import { expect, it } from "vitest";
import { deviceRouteRules, isDeviceRouteAllowed } from "./deviceAccessPolicy";

it("pins the device routes", () => {
  expect(deviceRouteRules()).toMatchInlineSnapshot(`
    [
      "GET ^\\/api\\/connect\\/session$",
      "DELETE ^\\/api\\/connect\\/session$",
      "GET ^\\/api\\/workspaces$",
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
});

// Every allowed route, then every near-miss of it: another method, or a path one edit away. A loosened regex
// (a missing anchor, an optional slash, a case-insensitive flag) lets one of these through and fails here.
it("allows each route exactly, and refuses every near-miss of it", () => {
  const allowed = [
    ["GET", "/api/connect/session"],
    ["DELETE", "/api/connect/session"],
    ["GET", "/api/workspaces"],
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
