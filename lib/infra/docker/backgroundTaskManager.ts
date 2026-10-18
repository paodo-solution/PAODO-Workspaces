// Tracks the agent's background processes (dev servers). Each runs in its own session, so it outlives runs and
// the exec kill path never reaches it. Bookkeeping and scripts only; the caller ensures the container.
import { randomUUID } from "crypto";
import { createLogger } from "../logger";
import { broadcastToWorkspace } from "../realtime/wsHub";
import type { IDockerClient } from "./dockerClient";
import { containerName } from "./naming";

const log = createLogger("container");

// Nudge any open UI to refetch its live-task list the instant a task starts or stops, so the
// presence badge stays in sync without waiting on its poll. No-op when nobody is connected.
function notifyTasksChanged(workspaceId: string): void {
  broadcastToWorkspace(workspaceId, JSON.stringify({ type: "background_tasks_changed" }));
}

// In-container directory holding background-task log/pid/cmd files. Under /tmp so it never
// clutters /workspace (which is bind-mounted and watched for file-change events).
const TASK_DIR = "/tmp/paodo-tasks";

// Per-task hard cap: a task is group-killed once it has run this long (measured from its own start),
// so no single background process keeps a container alive forever.
const CONTAINER_TASK_MAX_MS = 24 * 60 * 60 * 1000;

// One agent-launched background process (dev server etc.). pgid == the pid of the setsid
// session leader, so `kill -KILL -<pgid>` takes down the process and every child it spawned.
export interface BackgroundTask {
  taskId: string;
  pgid: number;
  logFile: string;
  command: string;
  startedAt: number; // epoch ms; drives the per-task cap, persisted via .started to survive a restart
}

export class BackgroundTaskManager {
  constructor(private docker: IDockerClient) {}

  // Tracked processes keyed workspaceId → taskId. Lost on app restart while the workspace container
  // (and its servers) keep running; rehydrate() rebuilds it from the container's pidfiles.
  private tasks = new Map<string, Map<string, BackgroundTask>>();
  // Workspaces already rehydrated from pidfiles in this process (at most once each); clear() resets it.
  private rehydrated = new Set<string>();

  // Launches detached (setsid, no --wait) with output to a log file, and returns at once. The command is
  // passed as argv $1, never interpolated; the process keeps `env` (secret tokens) for its lifetime.
  async start(
    workspaceId: string,
    command: string,
    env: Record<string, string> = {},
  ): Promise<{ taskId: string; logFile: string }> {
    const name = containerName(workspaceId);
    const taskId = randomUUID();
    const logFile = `${TASK_DIR}/${taskId}.output`;
    const pidFile = `${TASK_DIR}/${taskId}.pid`;
    const cmdFile = `${TASK_DIR}/${taskId}.cmd`;
    const startedFile = `${TASK_DIR}/${taskId}.started`;
    const startedAt = Date.now();
    let stage = "launch_process";

    try {
      // Same group-leader idiom as execStreaming, so the recorded pid is the server. .cmd and .started let
      // rehydrate() recover the command and keep the 24h cap's clock across an app restart.
      const launcher =
        `mkdir -p ${TASK_DIR}; ` +
        `printf '%s' "$1" > ${cmdFile}; ` +
        `date +%s > ${startedFile}; ` +
        `setsid /bin/bash -c 'echo $$ > ${pidFile}; exec "$0" "$@"' ` +
        `/bin/bash -c "$1" > ${logFile} 2>&1 & `;
      const launch = await this.docker.exec(name, ["/bin/bash", "-c", launcher, "bash", command], { env });
      if (launch.code !== 0) throw new Error(`background launch failed: ${launch.stderr}`);

      // Poll (in-container) up to ~2s for the self-reported pgid so a command that crashes on the
      // very first line still yields a pid we can report/track.
      stage = "capture_process_id";
      const read = await this.docker.exec(
        name,
        [
          "/bin/bash",
          "-c",
          `for i in $(seq 1 20); do if [ -s ${pidFile} ]; then cat ${pidFile}; exit 0; fi; sleep 0.1; done; exit 1`,
        ],
        { trimStdout: true },
      );
      const pgid = parseInt(read.stdout, 10);
      if (!read.code && Number.isInteger(pgid)) {
        let tasks = this.tasks.get(workspaceId);
        if (!tasks) this.tasks.set(workspaceId, (tasks = new Map()));
        tasks.set(taskId, { taskId, pgid, logFile, command, startedAt });
        notifyTasksChanged(workspaceId);
        log.info(
          {
            event: "background_task_started",
            outcome: "background_task_running",
            workspaceId,
            taskId,
            pgid,
          },
          "background task started",
        );
      } else {
        log.warn(
          {
            event: "background_task_tracking_failed",
            outcome: "background_task_running_untracked",
            workspaceId,
            taskId,
          },
          "background task started but pid was not captured",
        );
      }
    } catch (err) {
      log.error(
        {
          event: "background_task_start_failed",
          outcome: "background_task_not_started",
          err,
          workspaceId,
          taskId,
          stage,
        },
        "failed to start background task",
      );
      throw err;
    }
    return { taskId, logFile };
  }

  // Group-kills a tracked task, children included; false only if the task isn't tracked. Bookkeeping
  // and files are always cleared, even when the group was already dead.
  async stop(workspaceId: string, taskId: string): Promise<boolean> {
    const task = this.tasks.get(workspaceId)?.get(taskId);
    if (!task) return false;
    let stopped = false;
    try {
      const result = await this.docker.exec(containerName(workspaceId), [
        "/bin/bash",
        "-c",
        `kill -KILL -${task.pgid} 2>/dev/null; rm -f ${TASK_DIR}/${taskId}.pid ${TASK_DIR}/${taskId}.cmd ${TASK_DIR}/${taskId}.started`,
      ]);
      stopped = result.code === 0;
      if (!stopped) {
        log.error(
          {
            event: "background_task_stop_failed",
            outcome: "background_task_may_still_be_running",
            workspaceId,
            taskId,
            pgid: task.pgid,
            stderr: result.stderr,
          },
          "failed to stop background task",
        );
      }
    } catch (err) {
      log.error(
        {
          event: "background_task_stop_failed",
          outcome: "background_task_may_still_be_running",
          err,
          workspaceId,
          taskId,
          pgid: task.pgid,
        },
        "failed to stop background task",
      );
    }
    this.tasks.get(workspaceId)?.delete(taskId);
    notifyTasksChanged(workspaceId);
    if (stopped) {
      log.info(
        {
          event: "background_task_stopped",
          outcome: "background_task_stopped",
          workspaceId,
          taskId,
          pgid: task.pgid,
        },
        "background task stopped",
      );
    }
    return true;
  }

  // Running background tasks for a workspace — surfaced into the agent's context each turn so a
  // later run (which has no memory of a prior run's taskIds) can read their logs or stop them.
  list(workspaceId: string): BackgroundTask[] {
    return [...(this.tasks.get(workspaceId)?.values() ?? [])];
  }

  // Drop all bookkeeping for a workspace (its container is stopping/being removed — the processes
  // die with it) and reset the once-per-lifetime rehydration guard so a later reattach re-scans.
  clear(workspaceId: string): void {
    this.tasks.delete(workspaceId);
    this.rehydrated.delete(workspaceId);
  }

  // Rebuilds the task map from pidfiles once per workspace after an app restart, skipping dead groups.
  // Best-effort: on failure the map stays empty; never throws.
  async rehydrate(workspaceId: string): Promise<void> {
    if (this.rehydrated.has(workspaceId)) return;
    this.rehydrated.add(workspaceId);
    const live = await this.scanLiveTasks(workspaceId);
    if (live && live.size) {
      this.tasks.set(workspaceId, live);
      log.debug({ workspaceId, count: live.size }, "rehydrated background tasks from container");
    }
  }

  // Liveness read for the UI: rescans and prunes exited tasks but never kills, so a GET stays side-effect-free.
  async listLive(workspaceId: string): Promise<BackgroundTask[]> {
    const live = await this.scanLiveTasks(workspaceId);
    if (!live) return this.list(workspaceId);
    this.rehydrated.add(workspaceId);
    if (live.size) this.tasks.set(workspaceId, live);
    else this.tasks.delete(workspaceId);
    return [...live.values()];
  }

  // Authoritative liveness pass (idle reaper, boot sweep): unlike rehydrate() it always rescans —
  // rebuild from pidfiles (any session's task included), prune exited, kill over-cap; returns survivors.
  async reconcile(workspaceId: string): Promise<BackgroundTask[]> {
    const live = await this.scanLiveTasks(workspaceId);
    if (!live) return this.list(workspaceId);
    this.rehydrated.add(workspaceId);
    if (live.size) this.tasks.set(workspaceId, live);
    else this.tasks.delete(workspaceId);

    const now = Date.now();
    const survivors: BackgroundTask[] = [];
    for (const task of live.values()) {
      if (now - task.startedAt < CONTAINER_TASK_MAX_MS) {
        survivors.push(task);
        continue;
      }
      log.info(
        {
          event: "background_task_max_window_reached",
          outcome: "background_task_killed",
          workspaceId,
          taskId: task.taskId,
          pgid: task.pgid,
          ranMs: now - task.startedAt,
        },
        "background task killed — max task window reached",
      );
      await this.stop(workspaceId, task.taskId);
    }
    return survivors;
  }

  // One `kill -0` scan of the pidfiles → the live task map (dead groups are skipped, so this also
  // prunes). Line: "taskId<TAB>pgid<TAB>started<TAB>base64(command)". Null on any exec failure.
  private async scanLiveTasks(workspaceId: string): Promise<Map<string, BackgroundTask> | null> {
    const scan =
      `shopt -s nullglob; for p in ${TASK_DIR}/*.pid; do ` +
      `pgid=$(cat "$p" 2>/dev/null); [ -n "$pgid" ] || continue; ` +
      `kill -0 -"$pgid" 2>/dev/null || continue; ` +
      `id=$(basename "$p" .pid); ` +
      `started=$(cat "${TASK_DIR}/$id.started" 2>/dev/null); ` +
      `cmd=$(cat "${TASK_DIR}/$id.cmd" 2>/dev/null | base64 | tr -d "\\n"); ` +
      `printf '%s\\t%s\\t%s\\t%s\\n' "$id" "$pgid" "$started" "$cmd"; done`;
    const res = await this.docker
      .exec(containerName(workspaceId), ["/bin/bash", "-c", scan], { trimStdout: true })
      .catch((err) => {
        log.warn({ err, workspaceId }, "failed to scan background tasks");
        return null;
      });
    if (!res) return null;
    if (res.code !== 0) {
      // A stopped/missing container has no tasks to find — expected (e.g. a reaper pass after the
      // container already went down), so keep it at debug rather than raising an alert.
      if (/no such container|is not running/i.test(res.stderr)) {
        log.debug({ workspaceId, stderr: res.stderr }, "background-task scan skipped — container not running");
        return new Map();
      }
      log.warn({ workspaceId, stderr: res.stderr }, "failed to scan background tasks");
      return null;
    }
    const tasks = new Map<string, BackgroundTask>();
    if (!res.stdout) return tasks;
    for (const line of res.stdout.split("\n")) {
      const [taskId, pgidStr, startedStr, cmdB64] = line.split("\t");
      const pgid = parseInt(pgidStr, 10);
      if (!taskId || !Number.isInteger(pgid)) continue;
      // No .started defaults to "now", so a running server without one is never killed on the first scan.
      const startedSec = parseInt(startedStr, 10);
      const startedAt = Number.isInteger(startedSec) ? startedSec * 1000 : Date.now();
      const command = cmdB64 ? Buffer.from(cmdB64, "base64").toString("utf8") : "(unknown — recovered after restart)";
      tasks.set(taskId, { taskId, pgid, logFile: `${TASK_DIR}/${taskId}.output`, command, startedAt });
    }
    return tasks;
  }
}
