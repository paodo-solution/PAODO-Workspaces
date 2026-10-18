// Thin git spawner (callers pass every arg) behind IGitClient, so tests can fake it. Output is capped by the
// shared lib/infra/spawnCapture.ts, since `git diff` is one agent call away.
import { spawn } from "child_process";
import { SpawnCapture } from "../spawnCapture";

export type GitResult = {
  stdout: string;
  stderr: string;
  code: number;
  /** True when output hit the capture ceiling and stdout holds only the leading part. */
  truncated?: boolean;
};

export interface IGitClient {
  /** Runs `git <args>`. trimStdout defaults true (most git output we read is line-oriented). */
  run(args: string[], opts?: { trimStdout?: boolean }): Promise<GitResult>;
}

export class GitClient implements IGitClient {
  run(args: string[], opts: { trimStdout?: boolean } = {}): Promise<GitResult> {
    const { trimStdout = true } = opts;
    return new Promise((resolve) => {
      const captured = new SpawnCapture();
      let proc: ReturnType<typeof spawn>;
      try {
        proc = spawn("git", args);
      } catch (err) {
        // spawn can throw synchronously (e.g. EBADF during Next.js compilation, or git absent)
        // before the child is created, so proc.on("error") never fires in that case.
        resolve({ stdout: "", stderr: (err as Error).message, code: 1 });
        return;
      }
      captured.attach(proc);
      proc.on("close", (code) =>
        resolve({
          stdout: trimStdout ? captured.stdout.trim() : captured.stdout,
          stderr: captured.stderr.trim(),
          code: code ?? 1,
          truncated: captured.truncated,
        }),
      );
      proc.on("error", (err) => resolve({ stdout: "", stderr: err.message, code: 1 }));
      proc.stdin!.end();
    });
  }
}
