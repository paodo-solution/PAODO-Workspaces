// Agent tool that runs a bash command in the workspace, streaming output live to the console panel
// and returning the combined output as the tool result.

import { StructuredTool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createLogger } from "../../infra/logger";
import { checkFreeSpace, RESERVED_FREE_BYTES } from "@/lib/infra/storage/diskSpace";
import type { StreamingExecFn, BackgroundExecFn, ExecConfig, OutputSinkFn } from "../interfaces";
import { ExecOutput } from "./execOutput";

const schema = z.object({
  command: z.string().describe("The bash command to execute"),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      "Set true to run the command in the background: it returns immediately and keeps running " +
        "(you do NOT need a trailing '&'). Output is written to a log file whose path is " +
        "returned; read it later with execute_command (e.g. tail -n 200 <path>). Stop it with stop_task.",
    ),
});

// Maps known stderr signatures to actionable user guidance appended to the tool result.
// Returns "" when stderr is empty so callers can filter it out cleanly.
function diagnoseStderr(stderr: string): string {
  const trimmed = stderr.trim();
  if (!trimmed) return "";
  let out = `[stderr]: ${trimmed}`;
  if (trimmed.includes("no matching entries in passwd file")) {
    // Never suggests removing the container: its writable layer holds every package installed here,
    // and the fault is repairable in place.
    out +=
      "\n[setup] The container cannot resolve its runtime user. This is a container-level fault, not something you can fix from the shell — report it to the workspace owner. Do NOT suggest deleting or recreating the container: that would erase every package installed in this workspace.";
  } else if (trimmed.includes("Permission denied")) {
    out +=
      "\n[permission] You run as a non-root user and cannot modify system paths (e.g. /etc, /root, /usr). For workspace files, check ownership; to install system packages use the apt_install tool instead of apt-get. If you are building from source, configure with --prefix=$HOME/.local — your home is writable and persists.";
  }
  return out;
}

export class ExecCommandTool extends StructuredTool<typeof schema> {
  name = "execute_command";
  description = `Execute a bash shell command in the workspace directory.

Covers all shell operations including:
- File search:        find . -name "*.ts" (or fd)
- Content search:     grep -rn "pattern" --include="*.ts" (exclude node_modules/.git/.next automatically)
- File deletion:      rm filename
- Git operations:     git status, git log --oneline, git diff
- Running scripts:    node script.js, npm run build, python3 script.py
- Package management: npm install, pnpm install, pip3 install <package>
- JSON extraction:    jq '.key' file.json
- Piping/chaining:    cmd1 | cmd2, cmd1 && cmd2

Do NOT use for: reading file contents (use file_read), editing file contents (use file_edit), writing new file contents (use file_write).
USE THIS for: renaming files (mv), moving files, deleting files (rm), creating symlinks, and any other shell file-system operation that doesn't involve reading or writing file content.
Always use POSIX/bash syntax. Never use PowerShell syntax.
You run as a NON-ROOT user, confined to the workspace. apt-get/sudo are NOT available here — to install system packages use the apt_install tool. npm/pip/nvm/pyenv work normally.`;
  schema = schema;
  // Runner skips the WS tool_result_log broadcast for this tool — output already streams live.
  readonly suppressResultNotify = true;

  private readonly log = createLogger("execCommand");

  constructor(
    private readonly streamExec: StreamingExecFn,
    private readonly backgroundExec: BackgroundExecFn,
    private readonly broadcast: (msg: string) => void,
    private readonly execConfig: ExecConfig,
    private readonly workspaceDir: string,
    private readonly openOutputSink: OutputSinkFn,
  ) {
    super();
  }

  protected async _call(
    { command, run_in_background }: z.infer<typeof schema>,
    _runManager?: unknown,
    config?: RunnableConfig,
  ): Promise<string> {
    // A headroom gate, not a size check: a shell command declares no size, so only refuse when already full.
    const space = await checkFreeSpace(this.workspaceDir, 0, RESERVED_FREE_BYTES);
    if (!space.ok) {
      this.log.warn(
        { event: "exec_insufficient_storage", freeBytes: space.freeBytes },
        "command refused — low disk space",
      );
      return "Error: workspace is out of free disk space. Free up space (e.g. delete unneeded files) before running more commands.";
    }

    // Detached and fire-and-forget: the timeout and silence kills below must never reach a dev server.
    if (run_in_background) {
      try {
        const { taskId, logFile } = await this.backgroundExec(command);
        this.broadcast(
          JSON.stringify({ type: "stdout", data: `\n[background] started task ${taskId} → ${logFile}\n` }),
        );
        return (
          `Command running in background with task ID: ${taskId}\n` +
          `Output is being written to: ${logFile}\n` +
          `Read it with: execute_command "tail -n 200 ${logFile}". Stop it with stop_task.`
        );
      } catch (err) {
        return `Error: failed to start background command\n${String(err)}`;
      }
    }
    // The user's escape and the timeout/silence guards share one AbortController, which makes streamExec
    // kill the in-container process group.
    const userSignal = config?.signal;
    return new Promise<string>((resolve) => {
      // Bounded: output past the cap streams to a file in the container instead of this heap.
      const output = new ExecOutput(() => this.openOutputSink(randomUUID()));
      const startedAt = Date.now();
      let lastOutputAt = Date.now();
      let settled = false;
      const ctrl = new AbortController();

      const onUserAbort = () => killWith("Stopped by user.");

      const finish = (msg: string) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        userSignal?.removeEventListener("abort", onUserAbort);
        // Every exit path lands here, so this is where the sink's `docker exec` drain is reliably closed.
        output.close();
        resolve(msg);
      };

      const killWith = (reason: string) => {
        if (settled) return;
        this.log.warn({ commandChars: command.length, reason }, "command killed");
        this.broadcast(JSON.stringify({ type: "stdout", data: `\n[killed] ${reason}\n` }));
        ctrl.abort(); // real kill: streamExec tears down the process group
        finish(`[killed] ${reason}`); // unblock the agent immediately
      };

      // The async disk check can outlive one 5s tick, so it is guarded against overlap.
      let diskCheckInFlight = false;

      // "Still running" every 5s for the first 30s of silence, then every 30s.
      let lastHeartbeatAt = 0;

      const heartbeat = setInterval(() => {
        const now = Date.now();
        const silentMs = now - lastOutputAt;
        const elapsedMs = now - startedAt;
        const elapsed = Math.round(elapsedMs / 1000);

        if (elapsedMs >= this.execConfig.maxTimeoutMs) {
          killWith(`Command killed after ${elapsed}s (max runtime exceeded).`);
          return;
        }
        if (silentMs >= this.execConfig.silenceTimeoutMs) {
          killWith(`Command killed after ${Math.round(silentMs / 1000)}s with no output.`);
          return;
        }
        if (silentMs >= 5_000) {
          const interval = silentMs < 30_000 ? 5_000 : 30_000;
          if (now - lastHeartbeatAt >= interval) {
            lastHeartbeatAt = now;
            this.broadcast(JSON.stringify({ type: "stdout", data: `⏳ still running... (${elapsed}s elapsed)\n` }));
          }
        }

        // Mid-run counterpart of the pre-flight check: a clone or build can fill the disk while running.
        if (!diskCheckInFlight) {
          diskCheckInFlight = true;
          checkFreeSpace(this.workspaceDir, 0, RESERVED_FREE_BYTES)
            .then((result) => {
              if (!result.ok) killWith("Command killed: workspace ran out of disk space.");
            })
            .catch((err) => this.log.warn({ err }, "disk-space check during command execution failed"))
            .finally(() => {
              diskCheckInFlight = false;
            });
        }
      }, 5_000);

      if (userSignal) {
        if (userSignal.aborted) onUserAbort();
        else userSignal.addEventListener("abort", onUserAbort, { once: true });
      }

      this.streamExec(["/bin/bash", "-c", command], {
        signal: ctrl.signal,
        onStdout: (text) => {
          if (settled) return;
          lastOutputAt = Date.now();
          output.append("stdout", text);
          this.broadcast(JSON.stringify({ type: "stdout", data: text }));
        },
        onStderr: (text) => {
          if (settled) return;
          lastOutputAt = Date.now();
          output.append("stderr", text);
          this.broadcast(JSON.stringify({ type: "stderr", data: text }));
        },
      })
        .then(({ code }) => {
          if (settled) return;
          this.broadcast(JSON.stringify({ type: "exec_done", exitCode: code }));
          // A leading Error line marks non-zero exits for the agent and the usage dashboard.
          const failed = typeof code === "number" && code !== 0;
          const errorLine = failed ? `Error: command exited with code ${code}` : "";
          // Over the cap the result is a preview plus the file path. The stderr diagnosis is added either
          // way, since it is our guidance and not in the saved file.
          const body = output.overflowed
            ? [output.overflowNotice(), diagnoseStderr(output.stderrText())]
            : [output.stdoutText().trim(), diagnoseStderr(output.stderrText())];
          const parts = [errorLine, ...body].filter(Boolean);
          finish(parts.join("\n") || "Command executed successfully with no output.");
        })
        .catch((err) => {
          if (settled) return;
          // "Error:" prefix makes runner.classifyToolStatus mark it failed.
          finish(`Error: command execution failed\n${String(err)}`);
        });
    });
  }
}
