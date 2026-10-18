// Routes the one instance-wide CLI key may call; any method/path not listed is UI-only. Absent on purpose:
// settings/cli-access (a leaked key must not renew itself) and settings/provider-keys (see /api/models).

// `/api/workspaces/<id>/<suffix>`, or the workspace itself. Generated rather than hand-written, since an
// unescaped dot or missing `$` silently widens a rule.
function workspaceRule(method: string, suffix?: string) {
  return resourceRule("workspaces", method, suffix);
}

/** The same shape for a drive, so neither collection's rules are hand-written regexes. */
function driveRule(method: string, suffix?: string) {
  return resourceRule("drives", method, suffix);
}

/** A `{id}` segment in `suffix` matches exactly one path segment; every other segment is literal. */
function resourceRule(collection: string, method: string, suffix?: string) {
  const segments = suffix?.split("/").map((s) => (s === "{id}" ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const tail = segments ? `/${segments.join("/")}` : "";
  return { method, pathname: new RegExp(`^/api/${collection}/[^/]+${tail}$`) };
}

// Sent as `X-Paodo-Contract` so a mismatched client can say so. Raise it when a rule is removed or a
// route changes incompatibly; adding a rule or field does not count.
export const PLATFORM_CONTRACT_VERSION = 1;

// The credential channels a workspace exposes: the word a caller names one by, and its route segment.
// The rules below are generated from it and the contract publishes it, so a channel exists in one place.
export const CREDENTIAL_CHANNELS = { api: "api-key", mcp: "mcp-config" } as const;

const RULES: ReadonlyArray<{
  method: string;
  pathname: RegExp;
}> = [
  { method: "GET", pathname: /^\/api\/status$/ },
  // The model catalog, so workspace PATCH callers read valid combinations instead of learning by rejection.
  // Its `hasKey` flag replaces provider-keys, whose GET leaks masked key hints and whose writes move billing.
  { method: "GET", pathname: /^\/api\/models$/ },
  // What each PATCH accepts, so a caller's field list is the app's own rather than a copy that ages.
  { method: "GET", pathname: /^\/api\/contract$/ },
  { method: "GET", pathname: /^\/api\/workspaces$/ },
  { method: "POST", pathname: /^\/api\/workspaces$/ },
  workspaceRule("GET"),
  // PATCH cannot obtain a credential: issuing a key is POST on the channel's own route below.
  workspaceRule("PATCH"),
  // Irreversible: deleting a workspace takes its directory with it.
  workspaceRule("DELETE"),
  ...Object.values(CREDENTIAL_CHANNELS).flatMap((segment) => [
    workspaceRule("POST", segment),
    workspaceRule("DELETE", segment),
  ]),
  workspaceRule("GET", "files"),
  workspaceRule("GET", "files/content"),
  workspaceRule("DELETE", "files/content"),
  workspaceRule("GET", "files/transfer"),
  workspaceRule("PUT", "files/transfer"),
  // The one scheduled job: read, replace, or update named fields. There is no DELETE — pausing is `enabled: false`.
  workspaceRule("GET", "schedule"),
  workspaceRule("PUT", "schedule"),
  workspaceRule("PATCH", "schedule"),
  // Reading what a workspace ran; starting, continuing or stopping a conversation stays API/MCP-only.
  workspaceRule("GET", "conversations"),
  workspaceRule("GET", "conversations/{id}/sessions"),
  workspaceRule("GET", "conversations/{id}/sessions/{id}"),
  workspaceRule("GET", "conversations/{id}/sessions/{id}/calls"),
  workspaceRule("GET", "conversations/{id}/sessions/{id}/calls/{id}"),
  // Drives get the same file methods as workspaces and no more: a drive is shared by every connected
  // workspace, so widening its surface widens it for all of them.
  { method: "GET", pathname: /^\/api\/drives$/ },
  { method: "POST", pathname: /^\/api\/drives$/ },
  driveRule("GET"),
  driveRule("PATCH"),
  driveRule("DELETE"),
  driveRule("GET", "files"),
  driveRule("GET", "files/content"),
  driveRule("DELETE", "files/content"),
  driveRule("GET", "files/transfer"),
  driveRule("PUT", "files/transfer"),
  // Graphs are read whole and written one edge at a time. PUT /api/workspace-graph is absent: it
  // replaces node positions too, so a canvas-less caller would erase the layout.
  { method: "GET", pathname: /^\/api\/drive-connections$/ },
  { method: "POST", pathname: /^\/api\/drive-connections$/ },
  { method: "DELETE", pathname: /^\/api\/drive-connections$/ },
  { method: "GET", pathname: /^\/api\/workspace-graph$/ },
  { method: "POST", pathname: /^\/api\/workspace-graph\/edges$/ },
  { method: "DELETE", pathname: /^\/api\/workspace-graph\/edges$/ },
  // Either kind by two ids, or by one: which graph a pair or an id belongs to is decided in the app.
  // GET is the listing a caller with no canvas reads: both graphs joined, every end named.
  { method: "GET", pathname: /^\/api\/connections$/ },
  { method: "POST", pathname: /^\/api\/connections$/ },
  { method: "DELETE", pathname: /^\/api\/connections\/[^/]+$/ },
];

/** Every rule as `METHOD pattern`, for the test that pins this surface against the version above. */
export function platformRouteRules(): string[] {
  return RULES.map((rule) => `${rule.method} ${rule.pathname.source}`);
}

export function isPlatformRouteAllowed(method: string, pathname: string): boolean {
  return RULES.some((rule) => rule.method === method && rule.pathname.test(pathname));
}
