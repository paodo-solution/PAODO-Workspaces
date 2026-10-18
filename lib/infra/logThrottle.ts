// Throttles log lines unauthenticated callers can trigger, so a flood can't rotate real history out of
// Docker's capped logs. Opt-in per call site, only where repeats add no evidence.

type Window = { openedAt: number; suppressed: number; sources: Set<string> };

// Keyed by event name only, never client address, so a distributed flood is caught and the map stays tiny.
const windows = new Map<string, Window>();

// Enough to tell one persistent caller from a campaign without an unbounded set.
const MAX_TRACKED_SOURCES = 20;

// Returns `null` to drop the line, else how many lines it stands in for (0 on a window's first line).
// A burst that stops mid-window under-reports its tail; a sustained flood reports every window.
export function throttleLog(event: string, now = Date.now(), windowMs = 10_000): number | null {
  return rotate(event, undefined, now, windowMs)?.suppressed ?? null;
}

/** What a throttled line stands in for: how many were dropped, and who they came from. */
export type ThrottledWindow = {
  suppressed: number;
  /** Distinct addresses seen during the closed window, including the one that opened it. */
  sources: string[];
  /** True once MAX_TRACKED_SOURCES addresses were seen, i.e. the flood is likely distributed. */
  sourcesTruncated: boolean;
};

// `throttleLog` that also records sources, to tell one persistent guesser from a spread-out campaign.
// Shares windows with `throttleLog`, so an event throttles identically through either.
export function throttleLogWithSources(
  event: string,
  source: string,
  now = Date.now(),
  windowMs = 10_000,
): ThrottledWindow | null {
  return rotate(event, source, now, windowMs);
}

function rotate(event: string, source: string | undefined, now: number, windowMs: number): ThrottledWindow | null {
  const open = windows.get(event);
  if (!open || now - open.openedAt >= windowMs) {
    const sources = new Set<string>();
    if (source !== undefined) sources.add(source);
    windows.set(event, { openedAt: now, suppressed: 0, sources });
    return {
      suppressed: open ? open.suppressed : 0,
      sources: open ? [...open.sources] : [],
      sourcesTruncated: open ? open.sources.size >= MAX_TRACKED_SOURCES : false,
    };
  }
  open.suppressed += 1;
  if (source !== undefined && open.sources.size < MAX_TRACKED_SOURCES) open.sources.add(source);
  return null;
}

/** Test seam: the map is process-wide, so count assertions must start from zero. */
export function resetLogThrottle(): void {
  windows.clear();
}
