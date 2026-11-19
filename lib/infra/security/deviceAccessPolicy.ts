// Routes a VS Code device token may call; any method/path not listed is refused with 403. Kept apart from
// platformAccessPolicy.ts: a device is one person's editor, not the instance's admin CLI.

const RULES: ReadonlyArray<{ method: string; pathname: RegExp }> = [
  // Who this token belongs to, and signing out (the device revokes itself).
  { method: "GET", pathname: /^\/api\/connect\/session$/ },
  { method: "DELETE", pathname: /^\/api\/connect\/session$/ },
  // The live stream of change signals (ids only) that keeps the pickers and running LEDs current.
  { method: "GET", pathname: /^\/api\/connect\/events$/ },
  // The workspace picker: the list only, no create and no member routes yet.
  { method: "GET", pathname: /^\/api\/workspaces$/ },
  // The session picker: a workspace's conversation list, and New Chat.
  { method: "GET", pathname: /^\/api\/workspaces\/[^/]+\/conversations$/ },
  { method: "POST", pathname: /^\/api\/workspaces\/[^/]+\/conversations$/ },
  // One conversation: its transcript, chatting in it (send, or re-attach to a live run) and stopping it.
  // Conversation ids are UUIDs, so lowercase hex and dashes: that keeps `conversations/initial` out.
  { method: "GET", pathname: /^\/api\/workspaces\/[^/]+\/conversations\/[0-9a-f-]+$/ },
  { method: "POST", pathname: /^\/api\/workspaces\/[^/]+\/chat$/ },
  { method: "POST", pathname: /^\/api\/workspaces\/[^/]+\/conversations\/[0-9a-f-]+\/stop$/ },
  // Pull and Push: the tar transfer both ways, and deleting what Push removed locally.
  { method: "GET", pathname: /^\/api\/workspaces\/[^/]+\/files\/transfer$/ },
  { method: "PUT", pathname: /^\/api\/workspaces\/[^/]+\/files\/transfer$/ },
  { method: "DELETE", pathname: /^\/api\/workspaces\/[^/]+\/files\/content$/ },
];

/** Every rule as `METHOD pattern`, for the test that pins this surface. */
export function deviceRouteRules(): string[] {
  return RULES.map((rule) => `${rule.method} ${rule.pathname.source}`);
}

export function isDeviceRouteAllowed(method: string, pathname: string): boolean {
  return RULES.some((rule) => rule.method === method && rule.pathname.test(pathname));
}
