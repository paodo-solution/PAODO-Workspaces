// Reconnect backoff shared by useWorkspaceSocket and useConsoleSocket. Bounded so a handshake the browser
// can't satisfy doesn't loop forever (against the server, or as repeated Basic-Auth prompts).

// Most drops are blips (wifi switch, laptop wake), so retries continue forever, but never faster than
// the 30s cap.
export const WS_RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

// ±20%, so several hooks (and several tabs) that dropped at the same moment do not come back in
// lockstep and re-drop together.
const JITTER = 0.2;

// `attempt` is 1-based: the delay to wait before the Nth reconnect attempt.
export function wsReconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(attempt, 1), WS_RECONNECT_DELAYS_MS.length) - 1;
  const base = WS_RECONNECT_DELAYS_MS[index];
  return Math.round(base * (1 + (random() * 2 - 1) * JITTER));
}

// True once the schedule is exhausted: likely a redeploy invalidated the per-boot /ws cookie, which only a
// page load re-mints. Only decides whether to tell the user to reload.
export function isWsConnectionStale(attempt: number): boolean {
  return attempt >= WS_RECONNECT_DELAYS_MS.length;
}
