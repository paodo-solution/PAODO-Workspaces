// One container per workspace (ws_<id>) on its own internal network (wsnet_<id>), with /workspace and a
// durable /home/dev mounted from the volume. Started on demand, stopped after IDLE_TIMEOUT_MS idle.
import { access, mkdir, writeFile } from "fs/promises";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import path from "path";
import { createLogger, exitAfterLogs } from "../logger";
import { envArgs, type IDockerClient } from "./dockerClient";
import { ImageManager, HASH_LABEL } from "./imageManager";
import type { IContainerManager, OutputSink } from "../interfaces";
import {
  EXEC_OUTPUT_MAX_BYTES,
  EXEC_OUTPUT_KEEP,
  EXEC_OUTPUT_MAX_BACKLOG,
  EXEC_KILL_GRACE_MS,
  APT_REPLAY_TIMEOUT_MS,
} from "../limits";
import {
  CONTAINER_PREFIX,
  containerName,
  networkName,
  workspaceIdFromContainerName,
  workspaceIdFromNetworkName,
} from "./naming";
import { workspaceHomeDir, workspaceHomeSeededMarker, workspaceHomeSubpath } from "../paths";
import { readAptRecipe } from "../aptRecipe";
import { BackgroundTaskManager, type BackgroundTask } from "./backgroundTaskManager";
import { ProxyNetworkManager } from "./proxyNetworkManager";
import { capacityProfile } from "../capacityProfile";
import { runtimeMode } from "../runtimeMode";
import { assertWorkspacesVolumeConfigured } from "../startupChecks";
import { asDockerNetworkPoolExhaustedError, reportInfrastructureResourceExhaustion } from "./infrastructureFailure";

// Re-exported for back-compat with external consumers.
export type { BackgroundTask } from "./backgroundTaskManager";

const log = createLogger("container");

// Runs an output-stream callback so a throw inside it degrades this one command instead of killing
// the process. See the call sites in execStreaming for why an uncaught throw there is fatal.
function safeEmit(emit: () => void, workspaceId: string): void {
  try {
    emit();
  } catch (err) {
    log.error(
      { event: "docker_output_handler_failed", outcome: "output_chunk_dropped", err, workspaceId },
      "output handler threw — dropping this chunk",
    );
  }
}

/** Docker deletion is idempotent only when the named resource is explicitly absent. */
function isMissingContainer(stderr: string): boolean {
  return /no such container/i.test(stderr);
}

function isMissingNetwork(stderr: string): boolean {
  return /no such network|network\s+\S+\s+not found/i.test(stderr);
}

function dockerCleanupFailure(stage: string, result: { code: number; stderr: string }): string {
  return `${stage}: ${result.stderr || `exit ${result.code}`}`;
}

const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE ?? "paodo-workspace";
const CONTAINER_MEMORY = capacityProfile.workspaceMemoryLimit;
const CONTAINER_CPUS = capacityProfile.workspaceCpus;
// Docker's unlimited default lets one fork bomb exhaust the host's pid_max. Threads count too, so
// thread-heavy tools (JVM, `make -j`) may need it raised; hitting it reads "Resource temporarily unavailable".
const CONTAINER_PIDS = capacityProfile.workspacePidsLimit;
// Idle window once nothing keeps a container warm (no active run, no live task). Short and safe: a
// run suppresses it and it re-arms only on run end, so it can never fire mid-run.
const IDLE_TIMEOUT_MS = 2 * 60 * 1000;
// How long a per-workspace network must stay empty before the lazy sweep reclaims it. A grace window
// (a few reaper ticks) keeps a workspace that idles and quickly wakes from churning its network.
const DEFAULT_NETWORK_GRACE_MS = 20 * 60 * 1000;
// How often to re-check liveness while a live task keeps a container warm, so a task that exits on
// its own is noticed and the idle countdown can begin.
const TASK_POLL_MS = 60 * 1000;
// Over-cap output is parked here for the agent to read (see ExecOutput). Outside /workspace so the file
// tree, git and snapshots (`add --all --force`) never pick up spill files.
const EXEC_OUTPUT_DIR = "/tmp/paodo-exec";
// Where execStreaming parks a command's session-leader pid so its group can be killed later. Split
// into dir + prefix so the file it writes and the sweep that clears them can never drift apart.
const EXEC_PIDFILE_DIR = "/tmp";
const EXEC_PIDFILE_PREFIX = "paodo-exec-";
// Compose project + volume key ("paodo_ws_workspaces"). server.ts refuses to start without it, so the
// accessor throws instead of guessing: only a test can see null.
const WORKSPACES_VOLUME_NAME = runtimeMode.workspacesVolume;

function workspacesVolume(): string {
  assertWorkspacesVolumeConfigured(WORKSPACES_VOLUME_NAME);
  return WORKSPACES_VOLUME_NAME;
}
// Home of the `dev` user (Dockerfile.workspace), mounted durably so installed tooling outlives the
// container. SEED_TARGET is where the same directory is attached while it is being filled.
const AGENT_HOME = "/home/dev";
const SEED_TARGET = "/seed";

// Workspace policy and credential material needed by the Docker lifecycle. The concrete
// workspace/secret stores are wired only by defaultContainerManager.ts.
export interface ContainerWorkspaceDependencies {
  internetAccessFor(workspaceId: string): boolean;
  /** Env baked in at `docker run` (proxy routing, CA trust). Constant per workspace, so it never goes stale. */
  runEnvironment(workspaceId: string): { envArgs: string[]; hasProxyCA: boolean };
  /** Secret tokens, sent fresh on every exec: a container's env is frozen at creation and it is never recreated. */
  execEnvironment(workspaceId: string, internetAccess: boolean, relayReady: boolean): Record<string, string>;
  installProxyCA(docker: IDockerClient, containerName: string, workspaceId: string): Promise<void>;
  /** Starts the in-container egress relay (see proxyRelay.ts); true once it listens. Never rejects. */
  ensureProxyRelay(
    docker: IDockerClient,
    containerName: string,
    workspaceId: string,
    canInstall: boolean,
  ): Promise<boolean>;
}

// Safe standalone default for isolated unit tests and explicit custom composition. Production
// always supplies the real adapter from defaultContainerManager.ts.
const isolatedWorkspaceDependencies: ContainerWorkspaceDependencies = {
  internetAccessFor: () => false,
  runEnvironment: () => ({ envArgs: [], hasProxyCA: false }),
  execEnvironment: () => ({}),
  installProxyCA: async () => {},
  ensureProxyRelay: async () => false,
};

export class ContainerManager implements IContainerManager {
  private docker: IDockerClient;
  private imageManager: ImageManager;
  // Background tasks and credproxy sidecar networking are delegated; this class owns container and
  // network lifecycle and exec.
  private background: BackgroundTaskManager;
  private proxy: ProxyNetworkManager;
  constructor(
    docker: IDockerClient,
    private readonly workspaceDeps: ContainerWorkspaceDependencies = isolatedWorkspaceDependencies,
  ) {
    this.docker = docker;
    this.imageManager = new ImageManager(docker);
    this.background = new BackgroundTaskManager(docker);
    this.proxy = new ProxyNetworkManager(docker);
  }
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Runs driving each workspace; > 0 means never idle. A counter (not a flag) so nested call_agent
  // and concurrent runs nest cleanly — suppressed on run start, re-armed on run end.
  private activeRuns = new Map<string, number>();
  // Serializes run/start/stop per workspace. Concurrent ensure() calls share one promise; an in-flight
  // "stop" is waited out instead, since it resolves to stopped, not ready.
  private startLocks = new Map<string, { kind: "ensure" | "stop"; promise: Promise<void> }>();
  // Set once deletion begins and never cleared, so an in-flight agent can't recreate the container while
  // a partial deletion is retried.
  private removingWorkspaces = new Set<string>();
  // First time each managed network was seen empty by the sweep, so it is only reclaimed once it has
  // stayed empty across the grace window rather than the instant a workspace idles.
  private emptyNetworkSince = new Map<string, number>();
  // Whether the egress relay came up since the container last started. Absent means not checked yet,
  // as for a running container first seen after an app restart.
  private relayReady = new Map<string, boolean>();

  // Always --internal, whatever the internet setting, so the credproxy sidecar is the only egress path.
  // Docker can't flip --internal in place, so a non-internal network is deleted and recreated.
  private async ensureNetwork(workspaceId: string): Promise<void> {
    const name = networkName(workspaceId);
    const inspect = await this.docker.cmd("network", "inspect", name, "--format", "{{.Internal}}");
    if (inspect.code === 0) {
      if (inspect.stdout.trim() === "true") return;
      log.debug({ workspaceId }, "network is not --internal — recreating as internal");
      // After an unclean exit the stopped container or the sidecar can still hold an endpoint, which makes
      // `network rm` fail; force both off first (a no-op when nothing is attached).
      await this.docker.cmd("network", "disconnect", "-f", name, containerName(workspaceId));
      await this.proxy.detach(workspaceId);
      const rm = await this.docker.cmd("network", "rm", name);
      if (rm.code !== 0) throw new Error(`docker network rm failed while recreating as internal: ${rm.stderr}`);
    }
    const r = await this.docker.cmd(
      "network",
      "create",
      "--driver",
      "bridge",
      "--internal",
      "--label",
      "com.paodo.managed=workspace",
      "--label",
      `com.paodo.workspace-id=${workspaceId}`,
      name,
    );
    if (r.code !== 0) throw new Error(`docker network create failed: ${r.stderr}`);
  }

  // Runs on every wake, so a half-failed toggle heals instead of leaving the container offline. Internet
  // access is the sidecar's attachment alone; the healthy case costs one inspect.
  private async reconcileNetwork(workspaceId: string, internetAccess: boolean): Promise<void> {
    await this.ensureNetwork(workspaceId);
    const connect = await this.docker.cmd("network", "connect", networkName(workspaceId), containerName(workspaceId));
    // Already attached is success, not failure — this runs on every wake, so a healthy container is
    // the common case, not a fresh attachment.
    if (connect.code !== 0 && !/already (exists|connected)/i.test(connect.stderr)) {
      throw new Error(`docker network connect failed: ${connect.stderr}`);
    }
    // On: (re)attach the sidecar, which a redeploy may have dropped. Off: detach and CONFIRM it is gone,
    // so a workspace shown as off never keeps a route out.
    if (internetAccess) await this.proxy.attach(workspaceId);
    else await this.proxy.ensureDetached(workspaceId);
  }

  // A run has begun for this workspace: keep the container warm for its whole duration. Cancels any
  // pending idle/poll timer so nothing can stop the container mid-run, however long a model turn runs.
  noteRunStart(workspaceId: string): void {
    this.activeRuns.set(workspaceId, (this.activeRuns.get(workspaceId) ?? 0) + 1);
    const existing = this.idleTimers.get(workspaceId);
    if (existing) {
      clearTimeout(existing);
      this.idleTimers.delete(workspaceId);
    }
  }

  // A run has ended. When it was the last one, start counting down to idle (task-aware). Rescans
  // liveness authoritatively, since a run is exactly when a task may have been started or stopped.
  noteRunEnd(workspaceId: string): void {
    const next = (this.activeRuns.get(workspaceId) ?? 0) - 1;
    if (next > 0) this.activeRuns.set(workspaceId, next);
    else {
      this.activeRuns.delete(workspaceId);
      void this.scheduleReaper(workspaceId, true);
    }
  }

  // When to stop an idle container: suppressed while a run is active; with no live task, arm the base
  // window; with live task(s), keep warm and re-check on a poll (killing any past its cap).
  private async scheduleReaper(workspaceId: string, rescan: boolean): Promise<void> {
    const existing = this.idleTimers.get(workspaceId);
    if (existing) {
      clearTimeout(existing);
      this.idleTimers.delete(workspaceId);
    }
    if ((this.activeRuns.get(workspaceId) ?? 0) > 0) return;

    // rescan does the authoritative reconcile (a docker exec); the cheap ensure() path passes false.
    const live = rescan ? await this.background.reconcile(workspaceId) : this.background.list(workspaceId);
    // A run may have started while a rescan was in flight — don't arm a timer against it.
    if ((this.activeRuns.get(workspaceId) ?? 0) > 0) return;

    const hasTasks = live.length > 0;
    const t = setTimeout(
      () => {
        if (hasTasks) void this.scheduleReaper(workspaceId, true);
        else {
          void this.stop(workspaceId, "no live tasks — idle").catch((err) => {
            log.warn({ err, workspaceId }, "idle container stop failed");
          });
        }
      },
      hasTasks ? TASK_POLL_MS : IDLE_TIMEOUT_MS,
    );
    t.unref();
    // A concurrent schedule may have armed a timer during our await; clear it so we never orphan one.
    const prev = this.idleTimers.get(workspaceId);
    if (prev) clearTimeout(prev);
    this.idleTimers.set(workspaceId, t);
  }

  // Env for a single command, recomputed per exec so a secret change reaches the very next command.
  // Cheap: the secret store is in memory and the tokens are derived.
  private execEnv(workspaceId: string): Record<string, string> {
    const internetAccess = this.workspaceDeps.internetAccessFor(workspaceId);
    return this.workspaceDeps.execEnvironment(workspaceId, internetAccess, this.relayReady.get(workspaceId) === true);
  }

  // Once per container start: the relay dies with the container and nothing inside restarts it.
  private async startProxyRelay(workspaceId: string, internetAccess: boolean): Promise<void> {
    const name = containerName(workspaceId);
    const ready = await this.workspaceDeps.ensureProxyRelay(this.docker, name, workspaceId, internetAccess);
    this.relayReady.set(workspaceId, ready);
  }

  private async getContainerStatus(workspaceId: string): Promise<"running" | "stopped" | "missing"> {
    const r = await this.docker.cmd("inspect", "--format", "{{.State.Status}}", containerName(workspaceId));
    if (r.code !== 0) return "missing";
    if (r.stdout === "running") return "running";
    return "stopped";
  }

  // Docker 25+ volume-subpath mounting, always: the daemon resolves paths on the HOST, so a plain
  // bind of this container's /var/lib/paodo/data/<id> would hit nothing and mount an empty directory.
  private buildMountArg(subpath: string, target: string): string[] {
    return ["--mount", `type=volume,source=${workspacesVolume()},target=${target},volume-subpath=${subpath}`];
  }

  // Both durable mounts: the workspace tree the user sees, and the agent's home. Everything the
  // agent can write therefore survives container recreation — see seedAgentHome for why home needs it.
  private buildVolumeArgs(workspaceId: string, workspaceDir: string): string[] {
    return [
      ...this.buildMountArg(path.basename(workspaceDir), "/workspace"),
      ...this.buildMountArg(workspaceHomeSubpath(workspaceId), AGENT_HOME),
    ];
  }

  // Copies the image's /home/dev (nvm Node, pyenv), which the mount would hide, into the durable home once.
  // Fatal on failure: an empty home would surface later as "node is missing" instead of "setup failed".
  private async seedAgentHome(workspaceId: string): Promise<void> {
    const homeDir = workspaceHomeDir(workspaceId);
    // Must exist before docker run either way: volume-subpath refuses to mount a missing subpath.
    await mkdir(homeDir, { recursive: true });
    // A marker, not the directory's contents, is what says "done": a copy killed partway (disk full,
    // host restart) leaves files that would otherwise pass for a finished seed forever after.
    const marker = workspaceHomeSeededMarker(workspaceId);
    const seeded = await access(marker).then(
      () => true,
      () => false,
    );
    if (seeded) return;

    const r = await this.docker.cmd(
      "run",
      "--rm",
      "-u",
      "0",
      // It copies a directory and exits; nothing here should be reachable from or over the network.
      "--network",
      "none",
      ...this.buildMountArg(workspaceHomeSubpath(workspaceId), SEED_TARGET),
      CONTAINER_IMAGE,
      // Overwrites what it finds rather than skipping it, so a retry completes a partial home.
      "cp",
      "-a",
      `${AGENT_HOME}/.`,
      `${SEED_TARGET}/`,
    );
    if (r.code !== 0) throw new Error(`agent home seed failed: ${r.stderr || `exit ${r.code}`}`);
    await writeFile(marker, "");
    log.info(
      { event: "workspace_agent_home_seeded", outcome: "agent_home_ready", workspaceId },
      "agent home seeded from image",
    );
  }

  // Returns the packages that failed. apt-get is all-or-nothing, so if the joint install fails each
  // package is retried alone to salvage whatever is still installable.
  private async installRecipePackages(
    name: string,
    packages: string[],
    asRoot: { asRoot: true; trimStdout: true },
  ): Promise<string[]> {
    const install = (pkgs: string[]) =>
      this.docker.exec(name, ["apt-get", "install", "-y", "--no-install-recommends", ...pkgs], asRoot);

    if ((await install(packages)).code === 0) return [];

    const failed: string[] = [];
    for (const pkg of packages) {
      if ((await install([pkg])).code !== 0) failed.push(pkg);
    }
    return failed;
  }

  /** Severity tracks how much of the workspace's tooling is actually missing, not whether apt erred. */
  private reportReplay(workspaceId: string, packages: string[], failed: string[]): void {
    const restored = packages.filter((p) => !failed.includes(p));
    if (failed.length === 0) {
      log.info(
        { event: "apt_recipe_replayed", outcome: "system_packages_restored", workspaceId, packages },
        "reinstalled system packages into rebuilt container",
      );
      return;
    }
    const total = { workspaceId, failed, restored, failedCount: failed.length, restoredCount: restored.length };
    if (restored.length === 0) {
      log.error(
        { event: "apt_recipe_replay_failed", outcome: "system_packages_not_restored", ...total },
        "apt recipe replay failed — the rebuilt container has none of its system packages",
      );
      return;
    }
    log.warn(
      { event: "apt_recipe_replay_incomplete", outcome: "system_packages_partially_restored", ...total },
      "apt recipe replay incomplete — some system packages are missing from the rebuilt container",
    );
  }

  /** Refreshes the index and installs the recipe. Resolves however it goes; never rejects. */
  private async runRecipeReplay(
    workspaceId: string,
    name: string,
    packages: string[],
    asRoot: { asRoot: true; trimStdout: true },
  ): Promise<void> {
    try {
      const update = await this.docker.exec(name, ["apt-get", "update"], asRoot);
      if (update.code !== 0) {
        log.error(
          {
            event: "apt_recipe_replay_failed",
            outcome: "system_packages_not_restored",
            workspaceId,
            packages,
            stderr: update.stderr,
          },
          "apt index refresh failed — the rebuilt container has none of its system packages",
        );
        return;
      }
      const failed = await this.installRecipePackages(name, packages, asRoot);
      this.reportReplay(workspaceId, packages, failed);
    } catch (err) {
      log.error(
        { event: "apt_recipe_replay_failed", outcome: "system_packages_not_restored", err, workspaceId, packages },
        "apt recipe replay failed — the rebuilt container has none of its system packages",
      );
    }
  }

  // Create path only (`docker start` keeps installed packages). Never throws, and gives up after
  // APT_REPLAY_TIMEOUT_MS: every command waits on this, and a hung apt holds the dpkg lock for good.
  private async replayAptRecipe(workspaceId: string, internetAccess: boolean): Promise<void> {
    const packages = readAptRecipe(workspaceId);
    if (packages.length === 0) return;
    // An internet-less workspace sits on an --internal network with no route to the repos. Expected,
    // not a failure: apt_install is not even offered to the agent in that state (see buildTools).
    if (!internetAccess) {
      log.info(
        { event: "apt_recipe_replay_skipped", outcome: "system_packages_not_restored", workspaceId, packages },
        "skipping apt recipe replay — workspace has no internet access",
      );
      return;
    }

    const name = containerName(workspaceId);
    const asRoot = { asRoot: true, trimStdout: true } as const;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), APT_REPLAY_TIMEOUT_MS);
    });

    try {
      const outcome = await Promise.race([this.runRecipeReplay(workspaceId, name, packages, asRoot), deadline]);
      if (outcome === "timeout") {
        log.error(
          {
            event: "apt_recipe_replay_timed_out",
            outcome: "system_packages_not_restored",
            workspaceId,
            packages,
            timeoutMs: APT_REPLAY_TIMEOUT_MS,
          },
          "apt recipe replay timed out — continuing without the system packages so the workspace can start",
        );
        return;
      }
      // Same reason as the apt_install tool: the .debs and the index are pure download cache, and
      // this container is never recreated, so anything left here accumulates for its whole life.
      await this.docker
        .exec(name, ["/bin/sh", "-c", "apt-get clean; rm -rf /var/lib/apt/lists/*"], asRoot)
        .catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  }

  private async _ensureContainer(workspaceId: string, workspaceDir: string): Promise<void> {
    let stage = "inspect_container";
    // Read once so the network and proxy decisions below can't disagree. Fails closed (no internet)
    // when the workspace record is missing; one predating the field defaults to true.
    const internetAccess = this.workspaceDeps.internetAccessFor(workspaceId);
    try {
      const status = await this.getContainerStatus(workspaceId);

      // An existing container is ALWAYS reused as-is — drift from the image is intended, not stale.
      // Its state is recoverable anyway: /home/dev is durable, and apt packages replay from the recipe.
      if (status === "running") {
        // An app restart wiped the in-memory task map: rebuild it from pidfiles so a surviving
        // background process stays visible and stoppable.
        stage = "rehydrate_background_tasks";
        await this.background.rehydrate(workspaceId);
        stage = "reconcile_network";
        await this.reconcileNetwork(workspaceId, internetAccess);
        if (!this.relayReady.has(workspaceId)) {
          stage = "start_proxy_relay";
          await this.startProxyRelay(workspaceId, internetAccess);
        }
        return;
      }

      if (status === "stopped") {
        // Restart in place: `docker start` keeps the writable layer, so earlier installs survive.
        log.debug({ workspaceId }, "starting stopped container");
        stage = "reconcile_network";
        await this.reconcileNetwork(workspaceId, internetAccess);
        stage = "start_container";
        const r = await this.docker.cmd("start", containerName(workspaceId));
        if (r.code !== 0) throw new Error(`docker start failed: ${r.stderr}`);
        await this.sweepExecPidFiles(workspaceId);
        stage = "start_proxy_relay";
        await this.startProxyRelay(workspaceId, internetAccess);
        return;
      }

      // missing — first run for this workspace, so create and start
      log.debug({ workspaceId }, "creating container");
      stage = "ensure_network";
      await this.ensureNetwork(workspaceId);
      // Before the container exists, so its /home/dev mount has the image's runtimes to start from.
      stage = "seed_agent_home";
      await this.seedAgentHome(workspaceId);
      stage = "hash_workspace_image";
      // Create path only (it labels the new container), so a reused container never hashes the Dockerfile.
      const hash = await this.imageManager.getCurrentHash("Dockerfile.workspace");

      // Proxy routing + CA trust only: secrets go per exec, since this container's env is frozen.
      stage = "build_credential_environment";
      const { envArgs: runEnvArgs, hasProxyCA } = this.workspaceDeps.runEnvironment(workspaceId);
      // The sidecar makes the proxy alias resolve inside the container; an off workspace gets no route out.
      if (hasProxyCA && internetAccess) {
        stage = "attach_credential_proxy";
        await this.proxy.attach(workspaceId);
      }

      stage = "run_container";
      const r = await this.docker.cmd(
        "run",
        "-d",
        // tini as PID 1 reaps orphans; `sleep infinity` would leave every group-killed command a zombie.
        "--init",
        "--name",
        containerName(workspaceId),
        "--network",
        networkName(workspaceId),
        `--memory=${CONTAINER_MEMORY}`,
        `--cpus=${CONTAINER_CPUS}`,
        `--pids-limit=${CONTAINER_PIDS}`,
        ...this.buildVolumeArgs(workspaceId, workspaceDir),
        // Diagnostics only: a newer image never triggers a rebuild, which would discard the agent's installs.
        ...(hash ? ["--label", `${HASH_LABEL}=${hash}`] : []),
        ...runEnvArgs,
        // Only the caps the app's root execs need (apt, chown sweep, relay start); the non-root agent
        // can't use them, and no-new-privileges blocks setuid escalation.
        "--cap-drop",
        "ALL",
        "--cap-add",
        "CHOWN",
        "--cap-add",
        "DAC_OVERRIDE",
        "--cap-add",
        "FOWNER",
        "--cap-add",
        "FSETID",
        "--cap-add",
        "SETGID",
        "--cap-add",
        "SETUID",
        "--security-opt",
        "no-new-privileges:true",
        CONTAINER_IMAGE,
        "sleep",
        "infinity",
      );
      if (r.code !== 0) throw new Error(`docker run failed: ${r.stderr}`);
      log.info(
        {
          event: "workspace_container_capacity_applied",
          outcome: "workspace_container_created",
          workspaceId,
          containerMemoryLimit: CONTAINER_MEMORY,
          containerCpus: CONTAINER_CPUS,
          containerPidsLimit: CONTAINER_PIDS,
        },
        "workspace container created with capacity guardrails",
      );

      // Workspaces created when the agent ran as root hold root-owned files; hand the tree back to
      // uid 1000 so the agent and app can manage it. Idempotent and cheap.
      stage = "repair_workspace_ownership";
      const chown = await this.docker.exec(containerName(workspaceId), ["chown", "-R", "1000:1000", "/workspace"], {
        asRoot: true,
        trimStdout: true,
      });
      if (chown.code !== 0) {
        log.warn(
          {
            event: "workspace_ownership_repair_failed",
            outcome: "workspace_permissions_may_be_incorrect",
            workspaceId,
            stderr: chown.stderr,
          },
          "workspace ownership repair failed",
        );
      }

      // Proxy CA + combined trust bundle (no-op when the proxy isn't set up).
      stage = "install_proxy_ca";
      await this.workspaceDeps.installProxyCA(this.docker, containerName(workspaceId), workspaceId);

      // The relay is this container's only route out, so it must be up before apt needs it.
      stage = "start_proxy_relay";
      await this.startProxyRelay(workspaceId, internetAccess);

      // After the CA too: the image's GitHub CLI apt source is HTTPS, so an untrusted CA fails the refresh.
      stage = "replay_apt_recipe";
      await this.replayAptRecipe(workspaceId, internetAccess);
    } catch (err) {
      const exhaustion = asDockerNetworkPoolExhaustedError(err);
      if (!reportInfrastructureResourceExhaustion(log, exhaustion ?? err, { workspaceId, stage })) {
        log.error(
          {
            event: "workspace_container_start_failed",
            outcome: "workspace_container_unavailable",
            err,
            workspaceId,
            stage,
          },
          "workspace container failed to start",
        );
      }
      throw exhaustion ?? err;
    }
  }

  async ensure(workspaceId: string, workspaceDir: string): Promise<void> {
    // Join an in-flight ensure(); wait out an in-flight stop() and run a fresh pass. No `await` between the
    // check and the set below, so nothing else can claim the slot.
    for (;;) {
      if (this.removingWorkspaces.has(workspaceId)) {
        throw new Error(`workspace ${workspaceId} is being permanently deleted`);
      }
      const inflight = this.startLocks.get(workspaceId);
      if (!inflight) break;
      if (inflight.kind === "ensure") return inflight.promise;
      await inflight.promise.catch(() => {});
    }

    const p = (async () => {
      await this._ensureContainer(workspaceId, workspaceDir);
      // With internet on, verify (and reattach) the sidecar so the agent never hits cryptic proxy DNS errors.
      // Never for an off or unknown workspace: reattaching would undo its isolation.
      const internetAccess = this.workspaceDeps.internetAccessFor(workspaceId);
      if (internetAccess) {
        try {
          await this.proxy.verify(workspaceId);
        } catch (err) {
          const exhaustion = asDockerNetworkPoolExhaustedError(err);
          if (
            !reportInfrastructureResourceExhaustion(log, exhaustion ?? err, {
              workspaceId,
              stage: "verify_proxy_network",
            })
          ) {
            log.error(
              {
                event: "workspace_container_start_failed",
                outcome: "workspace_container_unavailable",
                err,
                workspaceId,
                stage: "verify_proxy_network",
              },
              "workspace container failed to start",
            );
          }
          throw exhaustion ?? err;
        }
      }
    })().finally(() => {
      if (this.startLocks.get(workspaceId)?.promise === p) this.startLocks.delete(workspaceId);
      // Refresh the idle schedule for non-run activity (file-write fallback, internet toggle). During
      // a run activeRuns > 0, so this no-ops and the run's own start/end owns the timer.
      if ((this.activeRuns.get(workspaceId) ?? 0) === 0) void this.scheduleReaper(workspaceId, false);
    });
    this.startLocks.set(workspaceId, { kind: "ensure", promise: p });
    return p;
  }

  // Non-streaming exec after ensure(). cmdArgs go straight to execvp (no shell); stdout is left untrimmed
  // so file content stays exact.
  async exec(
    workspaceId: string,
    workspaceDir: string,
    cmdArgs: string[],
    opts: { stdin?: import("./dockerClient").DockerStdin } = {},
  ) {
    await this.ensure(workspaceId, workspaceDir);
    return this.docker.exec(containerName(workspaceId), cmdArgs, {
      stdin: opts.stdin,
      env: this.execEnv(workspaceId),
    });
  }

  // Clears pid files that finished commands leave behind. Restart path only: the stop killed every process,
  // so none can belong to a live command. `find -delete` avoids ARG_MAX on a large backlog.
  private async sweepExecPidFiles(workspaceId: string): Promise<void> {
    const script = `find ${EXEC_PIDFILE_DIR} -maxdepth 1 -type f -name '${EXEC_PIDFILE_PREFIX}*.pid' -delete`;
    // Best effort: leftover pid files cost disk, never correctness, so a failure here must not stop
    // a container that has otherwise started cleanly.
    const r = await this.docker.exec(containerName(workspaceId), ["/bin/bash", "-c", script]).catch((err) => {
      log.warn({ err, workspaceId }, "failed to sweep orphaned exec pid files");
      return null;
    });
    if (r && r.code !== 0) {
      log.warn({ workspaceId, stderr: r.stderr }, "failed to sweep orphaned exec pid files");
    }
  }

  async execStreaming(
    workspaceId: string,
    workspaceDir: string,
    cmdArgs: string[],
    opts: { onStdout: (chunk: string) => void; onStderr: (chunk: string) => void; signal?: AbortSignal },
  ): Promise<{ code: number | null }> {
    await this.ensure(workspaceId, workspaceDir);
    const name = containerName(workspaceId);
    return new Promise((resolve) => {
      // setsid makes the command a group leader whose pid is recorded (`exec` keeps it), so `kill -<pid>`
      // stops it and its children; killing the host-side `docker exec` would only orphan them onto PID 1.
      const pidFile = `${EXEC_PIDFILE_DIR}/${EXEC_PIDFILE_PREFIX}${randomUUID()}.pid`;
      const launcher = `echo $$ > ${pidFile}; exec "$0" "$@"`;
      // --wait blocks until the leader exits and passes on its exit code; without it the exec returns at
      // once and no output streams.
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("docker", [
          "exec",
          "-i",
          ...envArgs(this.execEnv(workspaceId)),
          "-w",
          "/workspace",
          name,
          "setsid",
          "--wait",
          "/bin/bash",
          "-c",
          launcher,
          ...cmdArgs,
        ]);
      } catch (err) {
        log.error(
          { event: "docker_foreground_spawn_failed", outcome: "command_not_started", err, workspaceId },
          "failed to spawn Docker foreground command",
        );
        opts.onStderr(`${err instanceof Error ? err.message : String(err)}\n`);
        resolve({ code: 1 });
        return;
      }
      proc.stdin!.end();
      // Node calls these off any promise chain, so a throw would reach server.ts's uncaughtException
      // handler and kill the whole instance; safeEmit contains it.
      proc.stdout!.on("data", (chunk: Buffer) => safeEmit(() => opts.onStdout(chunk.toString()), workspaceId));
      proc.stderr!.on("data", (chunk: Buffer) => safeEmit(() => opts.onStderr(chunk.toString()), workspaceId));

      let killed = false;
      // Signals the whole in-container process group via the recorded session leader. Only the last
      // signal a command will ever get removes the pid file — the escalation still needs to read it.
      const signalGroup = (killSignal: "TERM" | "KILL", removePidFile: boolean) =>
        this.docker
          .exec(name, [
            "/bin/bash",
            "-c",
            `kill -${killSignal} -"$(cat ${pidFile} 2>/dev/null)" 2>/dev/null` +
              (removePidFile ? `; rm -f ${pidFile}` : ""),
          ])
          .catch((err) =>
            log.warn({ err, workspaceId, killSignal }, "failed to signal aborted foreground command inside container"),
          );

      // Ask, then force. The grace window is what lets git drop its index.lock and npm clear its
      // staging dir, so an interrupted command leaves a clean workspace rather than a repair job.
      const kill = () => {
        if (killed) return;
        killed = true;
        signalGroup("TERM", false);
        // The host-side client is deliberately left alone until the escalation: dropping it while
        // the group still lives orphans the command onto PID 1, which the pid-file kill exists to avoid.
        const escalation = setTimeout(() => {
          signalGroup("KILL", true);
          proc.kill("SIGKILL");
        }, EXEC_KILL_GRACE_MS);
        escalation.unref?.();
      };

      if (opts.signal) {
        if (opts.signal.aborted) kill();
        else opts.signal.addEventListener("abort", kill, { once: true });
      }

      let finished = false;
      const done = (code: number | null) => {
        if (finished) return;
        finished = true;
        opts.signal?.removeEventListener("abort", kill);
        // A pending escalation is deliberately NOT cancelled here: `setsid --wait` returns when the
        // group LEADER exits, so a sibling that blocked SIGTERM would be left with nothing to kill it.
        resolve({ code });
      };
      proc.on("close", (code) => done(code));
      proc.on("error", (err) => {
        log.error(
          { event: "docker_foreground_process_error", outcome: "command_failed", err, workspaceId },
          "Docker foreground command process error",
        );
        done(1);
      });
    });
  }

  // The only agent-facing root exec, for the `apt_install` tool. cmdArgs go as argv (no shell), so
  // callers must still validate untrusted input; the agent's own shell never runs as root.
  async execAsRoot(workspaceId: string, workspaceDir: string, cmdArgs: string[]) {
    await this.ensure(workspaceId, workspaceDir);
    return this.docker.exec(containerName(workspaceId), cmdArgs, {
      asRoot: true,
      trimStdout: true,
      // No secret env: apt needs only the egress route, which DockerClient keeps for root execs.
    });
  }

  // Drains over-cap output to a file through its own `docker exec`, leaving execStreaming's pid-recording
  // launcher untouched. No ensure(): a command is already mid-flight.
  openOutputSink(workspaceId: string, runId: string): OutputSink {
    // runId reaches a shell: sanitize it even though today's only caller passes a UUID.
    const safeId = runId.replace(/[^a-zA-Z0-9-]/g, "") || "run";
    const file = `${EXEC_OUTPUT_DIR}/${safeId}.output`;
    // `head -c` exits at the cap, so the EPIPE that follows means "full", not an error. The prune keeps the
    // newest files; `-mmin +1` spares spills other commands are still writing.
    const script =
      `mkdir -p ${EXEC_OUTPUT_DIR}; ` +
      `ls -1t ${EXEC_OUTPUT_DIR}/*.output 2>/dev/null | tail -n +${EXEC_OUTPUT_KEEP} | ` +
      `xargs -r find -mmin +1 2>/dev/null | xargs -r rm -f; ` +
      `head -c ${EXEC_OUTPUT_MAX_BYTES} > ${file}`;

    let alive = true;
    let truncated = false;
    let written = 0;
    let proc: ReturnType<typeof spawn> | null = null;

    const stop = (wasTruncated: boolean) => {
      if (!alive) return;
      alive = false;
      truncated = truncated || wasTruncated;
      try {
        proc?.stdin?.end();
      } catch {
        // Already torn down — nothing left to close.
      }
    };

    try {
      // stdin only. The sink's whole job is to take bytes; nothing reads what the drain prints, and
      // a piped stream no one reads is a buffer no one empties.
      proc = spawn("docker", ["exec", "-i", containerName(workspaceId), "/bin/bash", "-c", script], {
        stdio: ["pipe", "ignore", "ignore"],
      });
    } catch (err) {
      log.warn({ err, workspaceId }, "failed to open command output sink — over-cap output will not be saved");
      alive = false;
    }
    // EPIPE here is the normal end of a capped file, so this is a warn-free path; the error is only
    // interesting as the reason writing stopped.
    proc?.stdin?.on("error", () => stop(true));
    proc?.on("error", (err) => {
      log.warn({ err, workspaceId }, "command output sink failed — saved output may be incomplete");
      stop(true);
    });

    return {
      path: file,
      limit: EXEC_OUTPUT_MAX_BYTES,
      get truncated() {
        return truncated;
      },
      write(chunk: Buffer) {
        if (!alive || !proc?.stdin) return;
        // An undrained pipe queues in this heap, so past the backlog ceiling the file is left as a prefix:
        // the file is a convenience, staying alive is not.
        if (proc.stdin.writableLength > EXEC_OUTPUT_MAX_BACKLOG) {
          stop(true);
          return;
        }
        written += chunk.length;
        if (written > EXEC_OUTPUT_MAX_BYTES) truncated = true;
        proc.stdin.write(chunk);
      },
      close() {
        stop(false);
      },
    };
  }

  // Detached, long-lived background processes (dev servers etc.) — delegated to BackgroundTaskManager.
  // ensure() runs first so the container is up before the collaborator issues its in-container launch.
  async startBackground(
    workspaceId: string,
    workspaceDir: string,
    command: string,
  ): Promise<{ taskId: string; logFile: string }> {
    await this.ensure(workspaceId, workspaceDir);
    // A task keeps the env it started with; that can't outlive a revoked secret, because the token is
    // inert once the proxy drops its rule.
    return this.background.start(workspaceId, command, this.execEnv(workspaceId));
  }

  async stopBackground(workspaceId: string, taskId: string): Promise<boolean> {
    return this.background.stop(workspaceId, taskId);
  }

  listBackground(workspaceId: string): BackgroundTask[] {
    return this.background.list(workspaceId);
  }

  // Safe read for the UI: rescan pidfiles and prune exited tasks (so a self-exited one clears
  // promptly), without the reaper's cap-kill — a GET driven by this stays side-effect-free.
  async listBackgroundLive(workspaceId: string): Promise<BackgroundTask[]> {
    return this.background.listLive(workspaceId);
  }

  // Authoritative liveness pass: rebuild the map from pidfiles (surfacing tasks from any session),
  // prune exited ones, kill any past its cap; returns the survivors.
  async reconcileBackgroundTasks(workspaceId: string): Promise<BackgroundTask[]> {
    return this.background.reconcile(workspaceId);
  }

  // Applies the internet toggle to a running container by attaching or detaching the sidecar. Throws when
  // it can't be confirmed, so the caller can roll the persisted setting back.
  async applyInternetAccess(workspaceId: string, enabled: boolean): Promise<void> {
    // Wait out any in-flight ensure()/stop() before claiming the slot, so this can't interleave
    // with a bring-up that is halfway through wiring the old network. Mirrors stop().
    for (;;) {
      const inflight = this.startLocks.get(workspaceId);
      if (!inflight) break;
      await inflight.promise.catch(() => {});
    }

    const p = (async () => {
      // Only a RUNNING container has live networking to correct. A stopped/never-started workspace has
      // no attached endpoint; its network is (re)built on the next wake from the already-persisted flag.
      const status = await this.getContainerStatus(workspaceId);
      if (status !== "running") return;

      await this.reconcileNetwork(workspaceId, enabled);
    })();

    // Tagged "stop" so a concurrent ensure() waits it out instead of piggybacking — this promise
    // resolves to "network reconciled", not "container ready".
    this.startLocks.set(workspaceId, { kind: "stop", promise: p });
    try {
      await p;
    } finally {
      // Identity-checked like ensure() and stop(): only ever clear our own entry, never one a
      // later operation has since claimed.
      if (this.startLocks.get(workspaceId)?.promise === p) this.startLocks.delete(workspaceId);
    }
  }

  // On boot (prod only), reattach the sidecar to every running workspace with internet on. A workspace
  // whose record is missing is skipped (fails closed).
  async reattachProxyNetworks(): Promise<void> {
    await this.proxy.reattachAll((workspaceId) => {
      return this.workspaceDeps.internetAccessFor(workspaceId);
    });
  }

  // Re-arm the idle reaper for every running container after a restart (in-memory timers are lost).
  // scheduleReaper's reconcile recovers each task's cap from its .started file and reaps as needed.
  async resumeIdleReapers(): Promise<void> {
    const r = await this.docker.cmd("ps", "--filter", `name=^${CONTAINER_PREFIX}`, "--format", "{{.Names}}");
    if (r.code !== 0) {
      log.warn({ stderr: r.stderr }, "resumeIdleReapers: docker ps failed");
      return;
    }
    for (const name of r.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      const workspaceId = workspaceIdFromContainerName(name);
      if (workspaceId !== null) void this.scheduleReaper(workspaceId, true);
    }
  }

  // Reclaims managed networks that stop() emptied and that stayed empty past the grace window. Failures
  // retry on the next tick.
  async sweepManagedNetworks(graceMs = DEFAULT_NETWORK_GRACE_MS): Promise<void> {
    const ls = await this.docker.cmd(
      "network",
      "ls",
      "--filter",
      "label=com.paodo.managed=workspace",
      "--format",
      "{{.Name}}",
    );
    if (ls.code !== 0) {
      log.warn({ stderr: ls.stderr }, "sweepManagedNetworks: docker network ls failed");
      return;
    }
    const names = ls.stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const live = new Set(names);
    for (const name of [...this.emptyNetworkSince.keys()]) {
      if (!live.has(name)) this.emptyNetworkSince.delete(name);
    }
    const now = Date.now();
    for (const name of names) {
      const workspaceId = workspaceIdFromNetworkName(name);
      if (workspaceId === null) continue;
      const attached = await this.networkEndpointCount(name);
      if (attached === null) continue;
      if (attached > 0) {
        this.emptyNetworkSince.delete(name);
        continue;
      }
      const since = this.emptyNetworkSince.get(name) ?? now;
      if (!this.emptyNetworkSince.has(name)) this.emptyNetworkSince.set(name, now);
      if (now - since < graceMs) continue;
      await this.reclaimEmptyNetwork(workspaceId, name);
    }
  }

  // Number of endpoints attached to a network (container + credproxy sidecar), or null if the inspect
  // failed or the network vanished — both mean "skip and retry next tick".
  private async networkEndpointCount(name: string): Promise<number | null> {
    const r = await this.docker.cmd("network", "inspect", name, "--format", "{{len .Containers}}");
    if (r.code !== 0) return null;
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  // Remove one emptied network under the per-workspace lock, so it can never race a wake's
  // create+connect (ensure() waits out this "stop"-kind slot just like a real stop()).
  private async reclaimEmptyNetwork(workspaceId: string, name: string): Promise<void> {
    if (this.removingWorkspaces.has(workspaceId)) return;
    for (;;) {
      const inflight = this.startLocks.get(workspaceId);
      if (!inflight) break;
      await inflight.promise.catch(() => {});
    }
    const p = (async () => {
      // Re-check under the lock: a wake between the network ls and here may have reattached a container.
      if ((await this.networkEndpointCount(name)) !== 0) return;
      const rm = await this.docker.cmd("network", "rm", name);
      if (rm.code !== 0 && !isMissingNetwork(rm.stderr) && !/active endpoints/i.test(rm.stderr)) {
        log.debug({ workspaceId, stderr: rm.stderr }, "network reaper: rm failed, will retry");
        return;
      }
      this.emptyNetworkSince.delete(name);
    })();
    this.startLocks.set(workspaceId, { kind: "stop", promise: p });
    try {
      await p;
    } finally {
      if (this.startLocks.get(workspaceId)?.promise === p) this.startLocks.delete(workspaceId);
    }
  }

  async stop(workspaceId: string, reason?: string): Promise<void> {
    if (reason) {
      log.info(
        { event: "workspace_container_idled", outcome: "workspace_container_stopped", workspaceId, reason },
        "workspace container stopped",
      );
    }
    // Wait out any in-flight ensure()/stop() before claiming the slot, so a concurrent ensure() can't
    // reattach the sidecar while this tears the network down. See ensure() for the matching half.
    for (;;) {
      const inflight = this.startLocks.get(workspaceId);
      if (!inflight) break;
      await inflight.promise.catch(() => {});
    }

    const p = (async () => {
      const t = this.idleTimers.get(workspaceId);
      if (t) {
        clearTimeout(t);
        this.idleTimers.delete(workspaceId);
      }
      // Background processes and the relay die with the container — just drop the bookkeeping.
      this.background.clear(workspaceId);
      this.relayReady.delete(workspaceId);
      const r = await this.docker.cmd("stop", containerName(workspaceId));
      // A workspace that never ran has no container and is already stopped; any other non-zero result
      // is a teardown Docker could not confirm — surface it after the network cleanup below.
      const stopError =
        r.code !== 0 && !/no such container/i.test(r.stderr)
          ? new Error(`docker stop failed: ${r.stderr || `exit ${r.code}`}`)
          : null;
      if (stopError) log.warn({ workspaceId, stderr: r.stderr }, "docker stop failed");
      // Empty the network but do NOT `network rm` here — deleting the bridge reloads host routing and
      // blips the Cloudflare tunnel; networkReaper reclaims emptied networks lazily (reused on wake).
      await this.docker.cmd("network", "disconnect", networkName(workspaceId), containerName(workspaceId));
      await this.proxy.detach(workspaceId);
      if (stopError) throw stopError;
    })();
    this.startLocks.set(workspaceId, { kind: "stop", promise: p });
    try {
      await p;
    } finally {
      if (this.startLocks.get(workspaceId)?.promise === p) this.startLocks.delete(workspaceId);
    }
  }

  async remove(workspaceId: string): Promise<void> {
    // Mark first so no new ensure() claims the slot meanwhile. Kept even if cleanup fails: reviving the
    // container would restore only part of a workspace whose other state deletion already removed.
    this.removingWorkspaces.add(workspaceId);
    for (;;) {
      const inflight = this.startLocks.get(workspaceId);
      if (!inflight) break;
      await inflight.promise.catch(() => {});
    }

    const p = (async () => {
      const t = this.idleTimers.get(workspaceId);
      if (t) {
        clearTimeout(t);
        this.idleTimers.delete(workspaceId);
      }
      this.background.clear(workspaceId);
      this.relayReady.delete(workspaceId);
      // Attempt every step, excusing a failure ONLY when Docker says the resource is absent — anything
      // else could let deletion drop the registry while a live container survives it.
      const failures: string[] = [];
      const stop = await this.docker.cmd("stop", containerName(workspaceId));
      if (stop.code !== 0 && !isMissingContainer(stop.stderr)) {
        failures.push(dockerCleanupFailure("docker stop", stop));
      }
      const remove = await this.docker.cmd("rm", containerName(workspaceId));
      if (remove.code !== 0 && !isMissingContainer(remove.stderr)) {
        failures.push(dockerCleanupFailure("docker rm", remove));
      }
      try {
        await this.proxy.detach(workspaceId);
      } catch (err) {
        failures.push(`credential proxy detach: ${(err as Error).message}`);
      }
      const net = await this.docker.cmd("network", "rm", networkName(workspaceId));
      if (net.code !== 0 && !isMissingNetwork(net.stderr)) {
        failures.push(dockerCleanupFailure("docker network rm", net));
      }
      if (failures.length > 0) {
        throw new Error(`workspace Docker cleanup failed: ${failures.join("; ")}`);
      }
    })();

    // Reuse the teardown lock kind: ensure() must not coalesce onto a promise whose result means the
    // container is gone. The permanent marker above makes it reject rather than restart afterward.
    this.startLocks.set(workspaceId, { kind: "stop", promise: p });
    try {
      await p;
    } finally {
      if (this.startLocks.get(workspaceId)?.promise === p) this.startLocks.delete(workspaceId);
    }
  }

  // Removes a workspace dir from the volume as root, which also clears root-owned files from workspaces
  // created before the agent ran as uid 1000.
  async deleteWorkspaceDir(workspaceDir: string): Promise<void> {
    const r = await this.docker.cmd(
      "run",
      "--rm",
      "-u",
      "0",
      "-v",
      `${workspacesVolume()}:/data`,
      CONTAINER_IMAGE,
      "rm",
      "-rf",
      `/data/${path.basename(workspaceDir)}`,
    );
    if (r.code !== 0) throw new Error(`failed to delete workspace dir: ${r.stderr}`);
  }

  async assertDockerAvailable(): Promise<void> {
    const r = await this.docker.cmd("info");
    if (r.code !== 0) {
      log.fatal(
        { event: "startup_docker_unavailable", outcome: "process_exit", stderr: r.stderr },
        "Docker is not available. Make sure Docker is running before starting the server.",
      );
      exitAfterLogs(1);
    }
    try {
      await this.imageManager.ensureImage(CONTAINER_IMAGE, "Dockerfile.workspace");
    } catch (err) {
      log.fatal(
        {
          event: "startup_workspace_image_unavailable",
          outcome: "process_exit",
          err,
          image: CONTAINER_IMAGE,
        },
        "workspace image could not be inspected or built — refusing to start",
      );
      exitAfterLogs(1);
    }
  }
}
