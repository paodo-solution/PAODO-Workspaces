// Dev and deployment share one containerized topology; only whether Next compiles on demand differs.
// Imports nothing: both the Next and esbuild (proxyEntry.ts) bundles include it.
export interface RuntimeMode {
  /** Next compiles routes on demand (HMR), rather than serving a prebuilt .next. */
  readonly hotReload: boolean;
  /** Docker volume holding workspace data. Null only where nothing mounts it: tests, and the sidecar. */
  readonly workspacesVolume: string | null;
  /** Served as a hardened browser origin: Secure session cookie. */
  readonly hardenedBrowser: boolean;
}

type RuntimeEnvironment = Record<string, string | undefined>;

// hardenedBrowser tracks hotReload today, and is named apart from it deliberately: each call site
// says which property it actually depends on, so one can change later without dragging the other.
export function readRuntimeMode(env: RuntimeEnvironment = process.env): RuntimeMode {
  const hotReload = env.NODE_ENV !== "production";
  return {
    hotReload,
    workspacesVolume: env.WORKSPACES_VOLUME_NAME?.trim() || null,
    hardenedBrowser: !hotReload,
  };
}

export const runtimeMode = readRuntimeMode();
