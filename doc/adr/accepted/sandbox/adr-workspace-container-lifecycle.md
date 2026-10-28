# ADR — Workspace container lifecycle and image

Status: Accepted

## Context

Each workspace runs in its own container (see [container-per-workspace sandbox](adr-container-per-workspace-sandbox.md)). An idle container still holds memory, so containers should run only while used. Agents, however, install tools and start dev servers, and expect them to still be there next time. The workspace image also changes with the product. The platform must decide when a container is created, started, stopped or replaced, and what survives each step.

## Decision

A workspace's container is created once, started on demand, stopped when idle, and never recreated by the platform. `ContainerManager` (`lib/infra/docker/containerManager.ts`) owns all of it.

- **A container must be rebuildable from declared state**: everything a workspace keeps lives in the paths listed by `workspaceArtifactPaths` (`lib/infra/paths.ts`): the workspace tree, the home, the git history, the apt recipe, the saved apt packages and the seed marker. Backup, restore and deletion use that same list. Nothing may keep workspace state only in a container's writable layer, so removing a container and waking it again loses nothing but `/tmp` and running processes. Known gap: the image's runtimes under `/home/dev` are seeded only once.
- **Wake on demand**: every exec goes through `ensure()`, which takes one of three paths.
  - Running: reuse it and reconcile the network and sidecar. If the app restarted, its in-memory list of background tasks is gone, so it is rebuilt from the container's pidfiles; the processes themselves never stopped.
  - Stopped: reconcile the network, `docker start` (the writable layer keeps apt installs), restart the egress relay.
  - Missing: create the network, seed the home, `docker run` with the caps and limits, repair ownership, install the proxy CA, start the relay, replay the apt recipe.
- **State lives outside the container**: `/workspace` and `/home/dev` are volume-subpath mounts of `<root>/<id>` and `<root>/.homes/<id>`. The home is copied from the image once (`.seeded` marker). The agent is non-root, so apt packages are its only installs outside the home: `apt_install` records them in `.homes/<id>.apt.json` and keeps their .deb files in `.homes/<id>.apt-debs/`, which is never mounted. A new container reinstalls those files with no network, then downloads whatever is still missing if internet is on, best effort, within `APT_REPLAY_TIMEOUT_MS` (5 min).
- **Never recreated**: an existing container is reused as-is even after the image changes; drift is intended. The image hash label on a container is for diagnostics only.
- **One image**: `paodo-workspace` (`CONTAINER_IMAGE`), built from `Dockerfile.workspace` at boot by `ImageManager.ensureImage` when it is missing or its hash label differs. Boot fails if it cannot be built. A new image only reaches containers created afterwards.
- **Idle stop**: a per-workspace run counter (`noteRunStart`/`noteRunEnd`, so nested `call_agent` runs count) suppresses the reaper. After the last run ends, the container stops after 2 min, unless a background task (a dev server started with `run_in_background`) is live. A live task keeps the container running; the reaper re-checks every 60 s and kills any task older than 24 h (`CONTAINER_TASK_MAX_MS`). Stopping disconnects the network and detaches the sidecar; background processes and the relay die with the container and are never restarted.
- **One lock per workspace**: `startLocks` serializes `ensure`, `stop`, `applyInternetAccess` and network reclaim. Concurrent `ensure` calls share one promise, and `ensure` waits out a stop. `remove()` sets a permanent marker so an in-flight run cannot revive a workspace being deleted.
- **Networks reclaimed lazily**: stopping empties the network but keeps it, because deleting a bridge reloads host routing and briefly drops the Cloudflare tunnel. `networkReaper` deletes networks empty for 20 min (`NETWORK_REAP_GRACE_MS`, checked every `NETWORK_REAP_TICK_MS`, default 10 min).
- **Self-healing**: workspace containers are separate from the app container, so an app restart leaves them, and their background tasks, running. At boot, `reattachProxyNetworks` and `resumeIdleReapers` rebuild the app's lost bookkeeping from `docker ps` and the pidfiles, including each task's start time (`.started`), so the 24 h cap keeps counting. `proxyReconciler` re-runs the attachment every 60 s (`PROXY_RECONCILE_TICK_MS`), so a sidecar redeploy heals without an app restart.
- **Deletion fails loudly**: `remove()` attempts stop, `rm`, sidecar detach and network `rm`, and fails unless each step succeeded or Docker reports the resource absent.

## Consequences

- An idle workspace costs only disk. The first command after an idle stop waits for `docker start` and the relay.
- Installed tooling survives stop and start. The home and apt packages also survive losing the container, whatever the internet setting (restore, box migration, manual `docker rm`).
- Image updates, security patches included, never reach existing containers. Rolling one out means removing the container by hand.
- Run-time settings (env, capabilities, mounts, `CONTAINER_MEMORY`, `CONTAINER_CPUS`, `CONTAINER_PIDS_LIMIT`) apply only to containers created after the change. Secrets therefore go per exec.
- A dev server keeps its container, and that container's memory, up for as long as 24 h with no run.
- An app restart never touches workspace containers or their background tasks; only the app's own bookkeeping (task list, idle timers, sidecar attachment) is rebuilt. Without that rebuild, the reaper would see no task and stop a container whose dev server is still running.
- The writable layer grows with apt installs for the container's whole life, and each installed .deb is also kept on the volume and in every backup.
- Building on the box leaves a build cache that grows with every Dockerfile change, and each box builds its own copy.
- Timers, locks and relay state are in memory, which ties this to a single instance (see [single-instance state](../platform/adr-single-instance-in-process-state.md)).
- Does NOT stop: stale or vulnerable software in long-lived containers. Only the hash label shows which image a container was created from.

## Alternatives considered

- **Always-on containers**: memory would grow with the number of workspaces instead of the active ones.
- **Ephemeral container per run**: every run cold-starts, and background servers cannot outlive a run.
- **Recreate containers when the image changes**: rolls updates out, but restarts every workspace on deploy and drops whatever the home and saved apt packages do not capture.
- **Delete the network on stop**: briefly drops the Cloudflare tunnel on every idle stop.

## Notes

- Code: `lib/infra/docker/containerManager.ts`, `imageManager.ts`, `networkReaper.ts`, `proxyReconciler.ts`, `backgroundTaskManager.ts`, `aptDebsTransfer.ts`, `lib/infra/aptRecipe.ts`, `aptDebs.ts`, `server.ts` (boot order).
- Related: [container-per-workspace sandbox](adr-container-per-workspace-sandbox.md), [internet access toggle](adr-workspace-internet-access-toggle.md), [credential proxy](adr-workspace-secrets-credential-proxy.md), [single-instance state](../platform/adr-single-instance-in-process-state.md), [prd-workspace-image-registry.md](../../../prd/draft/prd-workspace-image-registry.md) (draft: build the image in CI instead of on each box).
