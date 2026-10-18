// Lazily reclaims workspace networks that stop() emptied: deleting a bridge inline reloads host routing and
// blips the Cloudflare tunnel. sweepManagedNetworks() is idempotent, so the tick is cheap.
import { getContainers } from "../services";
import { createLogger } from "../logger";
import { globalSingleton } from "../globalSingleton";

const log = createLogger("networkReaper");

const DEFAULT_TICK_MS = 600_000;

type ReaperState = {
  timer: NodeJS.Timeout | null;
  running: boolean;
};
const state = globalSingleton<ReaperState>("networkReaperState", () => ({
  timer: null,
  running: false,
}));

function graceMs(): number | undefined {
  const configured = Number(process.env.NETWORK_REAP_GRACE_MS);
  return Number.isFinite(configured) && configured >= 0 ? configured : undefined;
}

async function tick(): Promise<void> {
  // Skip if a prior tick is still in flight (docker calls can be slow) so ticks never pile up.
  if (state.running) return;
  state.running = true;
  try {
    await getContainers().sweepManagedNetworks(graceMs());
  } catch (err) {
    log.warn({ err }, "network reaper tick failed");
  } finally {
    state.running = false;
  }
}

/** Start the sweep loop. Idempotent. */
export function startNetworkReaper(): void {
  if (state.timer) return;
  const configuredTickMs = Number(process.env.NETWORK_REAP_TICK_MS);
  const tickMs = Number.isFinite(configuredTickMs) && configuredTickMs > 0 ? configuredTickMs : DEFAULT_TICK_MS;
  state.timer = setInterval(tick, tickMs);
  state.timer.unref?.();
  log.info({ tickMs }, "network reaper started");
}

export function stopNetworkReaper(): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
  log.info("network reaper stopped");
}

// Exported for tests to drive a single sweep deterministically.
export { tick as _reapTick };
