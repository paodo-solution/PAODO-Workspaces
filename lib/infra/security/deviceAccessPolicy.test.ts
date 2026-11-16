// The surface a VS Code device token can reach. Widening it is a deliberate, reviewed change to this snapshot.
import { expect, it } from "vitest";
import { deviceRouteRules, isDeviceRouteAllowed } from "./deviceAccessPolicy";

it("pins the device routes", () => {
  expect(deviceRouteRules()).toMatchInlineSnapshot(`
    [
      "GET ^\\/api\\/connect\\/session$",
      "DELETE ^\\/api\\/connect\\/session$",
    ]
  `);
});

it("refuses admin, settings and token-minting routes", () => {
  expect(isDeviceRouteAllowed("GET", "/connect/vscode")).toBe(false);
  expect(isDeviceRouteAllowed("GET", "/api/settings/vscode-access")).toBe(false);
  expect(isDeviceRouteAllowed("DELETE", "/api/workspaces/x")).toBe(false);
  expect(isDeviceRouteAllowed("GET", "/api/connect/session/x")).toBe(false);
});
