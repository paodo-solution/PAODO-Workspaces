// Routes a VS Code device token may call; any method/path not listed is refused with 403. Kept apart from
// platformAccessPolicy.ts: a device is one person's editor, not the instance's admin CLI.

const RULES: ReadonlyArray<{ method: string; pathname: RegExp }> = [
  // Who this token belongs to, and signing out (the device revokes itself).
  { method: "GET", pathname: /^\/api\/connect\/session$/ },
  { method: "DELETE", pathname: /^\/api\/connect\/session$/ },
];

/** Every rule as `METHOD pattern`, for the test that pins this surface. */
export function deviceRouteRules(): string[] {
  return RULES.map((rule) => `${rule.method} ${rule.pathname.source}`);
}

export function isDeviceRouteAllowed(method: string, pathname: string): boolean {
  return RULES.some((rule) => rule.method === method && rule.pathname.test(pathname));
}
