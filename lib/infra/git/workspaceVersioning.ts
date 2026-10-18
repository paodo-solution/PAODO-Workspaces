// Snapshot versioning, independent of the agent's own git: the git-dir lives outside the tree at
// .versioning/<id>, and `add --all --force` ignores .gitignore. A nested repo is stored as a gitlink.
import path from "path";
import { mkdir, rm } from "fs/promises";
import { createAuditLogger, createLogger } from "../logger";
import { WORKSPACES_ROOT } from "../paths";
import { GitClient, type IGitClient } from "./gitClient";
import type { HistoryEntry, IWorkspaceVersioning, VersionStat, VersionFileStat } from "../interfaces";

const log = createLogger("versioning");
const audit = createAuditLogger("versioning");

// Stable commit identity so we never depend on (or mutate) the host's global git config.
const IDENTITY = ["-c", "user.name=PAODO Agent", "-c", "user.email=agent@paodo.local"];
// Disable global/home excludes; combined with `add --force` this guarantees a full snapshot.
const NO_EXCLUDES = ["-c", "core.excludesFile=/dev/null"];

const MAX_SUBJECT = 72;

function truncateSubject(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT);
}

// gitClient caps output, and a silently cut diff would read as "nothing else changed", so say it was cut.
function noteIfTruncated(diff: string, truncated: boolean | undefined): string {
  if (!truncated) return diff;
  return `${diff}\n[diff truncated — this snapshot is too large to show in full; narrow it with path]`;
}

export interface WorkspaceVersioningOptions {
  /** Root under which the `.versioning/<id>` git-dirs live. Defaults to WORKSPACES_ROOT. */
  rootDir?: string;
}

export class WorkspaceVersioning implements IWorkspaceVersioning {
  private git: IGitClient;
  private rootDir: string;
  // Per-workspace promise chain: serializes index-mutating ops so concurrent runs on one
  // workspace can't race the git index. Mirrors containerManager's start-lock pattern.
  private locks = new Map<string, Promise<unknown>>();

  constructor(git: IGitClient = new GitClient(), opts: WorkspaceVersioningOptions = {}) {
    this.git = git;
    this.rootDir = opts.rootDir ?? WORKSPACES_ROOT;
  }

  private gitDirFor(workspaceId: string): string {
    return path.join(this.rootDir, ".versioning", workspaceId);
  }

  // The --git-dir/--work-tree prefix that every command needs.
  private base(workspaceId: string, workspaceDir: string): string[] {
    return ["--git-dir", this.gitDirFor(workspaceId), "--work-tree", workspaceDir];
  }

  private serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    // Chain onto the tail regardless of how the previous op settled; the stored tail swallows
    // errors so one failure can't poison the chain. The caller still sees fn's real result.
    const tail = prev.then(fn, fn);
    this.locks.set(
      key,
      tail
        .catch(() => {})
        .finally(() => {
          if (this.locks.get(key) === stored) this.locks.delete(key);
        }),
    );
    const stored = this.locks.get(key)!;
    return tail;
  }

  // ---- stage everything (ignore the user's ignore rules) ----
  private addAll(workspaceId: string, workspaceDir: string) {
    return this.git.run([...this.base(workspaceId, workspaceDir), ...NO_EXCLUDES, "add", "--all", "--force"]);
  }

  private async headSha(workspaceId: string, workspaceDir: string): Promise<string | null> {
    const r = await this.git.run([...this.base(workspaceId, workspaceDir), "rev-parse", "--verify", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  private async isClean(workspaceId: string, workspaceDir: string): Promise<boolean> {
    const r = await this.git.run([...this.base(workspaceId, workspaceDir), "status", "--porcelain"]);
    return r.stdout.trim() === "";
  }

  private async commit(
    workspaceId: string,
    workspaceDir: string,
    message: string,
    extra: string[] = [],
  ): Promise<string> {
    const r = await this.git.run([
      ...this.base(workspaceId, workspaceDir),
      ...IDENTITY,
      "commit",
      "-m",
      message,
      ...extra,
    ]);
    if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr || r.stdout}`);
    const sha = await this.headSha(workspaceId, workspaceDir);
    if (!sha) throw new Error("git commit succeeded but HEAD is unresolved");
    return sha;
  }

  // ---- public API (each mutating method serialized on workspaceId) ----

  // Idempotent: `git init` is safe to re-run, so we always init then commit only if HEAD is absent.
  private async _initRepo(workspaceId: string, workspaceDir: string): Promise<void> {
    await mkdir(path.dirname(this.gitDirFor(workspaceId)), { recursive: true });
    // init WITHOUT --work-tree: with our git-dir outside the tree, init would otherwise persist
    // core.worktree as an absolute path, coupling the repo to today's root and breaking on a move.
    const init = await this.git.run(["--git-dir", this.gitDirFor(workspaceId), "init"]);
    if (init.code !== 0) throw new Error(`git init failed: ${init.stderr || init.stdout}`);
    if (await this.headSha(workspaceId, workspaceDir)) return; // already has a root commit
    await this.addAll(workspaceId, workspaceDir);
    // --allow-empty so a freshly-created (or empty) workspace still gets a stable baseline ref.
    await this.commit(workspaceId, workspaceDir, "init", ["--allow-empty"]);
  }

  initRepo(workspaceId: string, workspaceDir: string): Promise<void> {
    return this.serialize(workspaceId, () => this._initRepo(workspaceId, workspaceDir));
  }

  commitBaseline(workspaceId: string, workspaceDir: string, prompt: string): Promise<{ sha: string }> {
    return this.serialize(workspaceId, async () => {
      await this._initRepo(workspaceId, workspaceDir);
      await this.addAll(workspaceId, workspaceDir);
      if (await this.isClean(workspaceId, workspaceDir)) {
        const sha = await this.headSha(workspaceId, workspaceDir);
        return { sha: sha! };
      }
      const sha = await this.commit(workspaceId, workspaceDir, `pre-run (user prompt): ${truncateSubject(prompt)}`);
      return { sha };
    });
  }

  commitResult(workspaceId: string, workspaceDir: string, summary: string): Promise<{ sha: string; changed: boolean }> {
    return this.serialize(workspaceId, async () => {
      await this._initRepo(workspaceId, workspaceDir);
      await this.addAll(workspaceId, workspaceDir);
      if (await this.isClean(workspaceId, workspaceDir)) {
        const sha = await this.headSha(workspaceId, workspaceDir);
        return { sha: sha!, changed: false };
      }
      // Run number derives from git itself (count of run/* tags) so it survives restarts and
      // stays correct under the per-workspace lock above.
      const tags = await this.git.run([...this.base(workspaceId, workspaceDir), "tag", "--list", "run/*"]);
      const n = tags.stdout.trim() === "" ? 1 : tags.stdout.trim().split("\n").length + 1;
      const sha = await this.commit(workspaceId, workspaceDir, `run ${n} (user prompt): ${truncateSubject(summary)}`);
      await this.git.run([...this.base(workspaceId, workspaceDir), "tag", `run/${n}`, sha]);
      return { sha, changed: true };
    });
  }

  async history(workspaceId: string, workspaceDir: string): Promise<HistoryEntry[]> {
    const head = await this.headSha(workspaceId, workspaceDir);
    if (!head) return [];
    // --all keeps snapshots after a restore visible (their run/* tags survive reset --hard), so the user can
    // jump forward again. %x1f separates fields and %x1e records, safe against newlines.
    const r = await this.git.run(
      [...this.base(workspaceId, workspaceDir), "log", "--all", "--pretty=format:%H%x1f%ct%x1f%s%x1e"],
      { trimStdout: false },
    );
    if (r.code !== 0) return [];
    return r.stdout
      .split("\x1e")
      .map((rec) => rec.replace(/^\n/, ""))
      .filter((rec) => rec.trim() !== "")
      .map((rec) => {
        const [sha, ct, subject] = rec.split("\x1f");
        return {
          sha,
          message: subject ?? "",
          timestamp: new Date(Number(ct) * 1000).toISOString(),
          current: sha === head,
        };
      });
  }

  async diff(workspaceId: string, workspaceDir: string, from: string, to: string): Promise<string> {
    const r = await this.git.run([...this.base(workspaceId, workspaceDir), "diff", from, to], { trimStdout: false });
    return noteIfTruncated(r.stdout, r.truncated);
  }

  // Snapshots across all refs with per-file numstat, newest `n` or all. Read-only, so unlocked. Binary
  // files report -1 for add/del so the formatter can mark them.
  async versionStats(workspaceId: string, workspaceDir: string, n?: number): Promise<VersionStat[]> {
    const count = n === undefined ? undefined : Math.max(1, Math.floor(n) || 1);
    const head = await this.headSha(workspaceId, workspaceDir);
    if (!head) return [];
    const limitArgs = count === undefined ? [] : [`-n${count}`];
    const r = await this.git.run(
      [
        ...this.base(workspaceId, workspaceDir),
        "log",
        "--all",
        ...limitArgs,
        "--no-renames",
        "--numstat",
        "--pretty=format:%x1e%h%x1f%cr%x1f%s",
      ],
      { trimStdout: false },
    );
    if (r.code !== 0) return [];
    return r.stdout
      .split("\x1e")
      .filter((rec) => rec.trim() !== "")
      .map((rec) => {
        const lines = rec.replace(/^\n/, "").split("\n");
        const [sha, age, subject] = lines[0].split("\x1f");
        const files: VersionFileStat[] = [];
        let totalAdd = 0;
        let totalDel = 0;
        for (const line of lines.slice(1)) {
          const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
          if (!m) continue;
          const add = m[1] === "-" ? -1 : Number(m[1]);
          const del = m[2] === "-" ? -1 : Number(m[2]);
          files.push({ path: m[3], add, del });
          if (add > 0) totalAdd += add;
          if (del > 0) totalDel += del;
        }
        // head is the full %H; the log emits abbreviated %h, so prefix-match to flag the snapshot
        // the work-tree is currently on (this is what a UI restore's reset --hard moves).
        const current = head.startsWith(sha);
        return { sha, age: age ?? "", subject: subject ?? "", files, totalAdd, totalDel, current };
      });
  }

  // Raw diff for a single snapshot (`git show sha`), optionally narrowed to one path. The tool
  // layer strips boilerplate and pages length; here we just emit git's native output. Read-only.
  async versionDiff(
    workspaceId: string,
    workspaceDir: string,
    sha: string,
    opts: { path?: string } = {},
  ): Promise<string> {
    const args = [...this.base(workspaceId, workspaceDir)];
    args.push("show", "--no-renames", sha);
    if (opts.path) args.push("--", opts.path);
    const r = await this.git.run(args, { trimStdout: false });
    return noteIfTruncated(r.stdout, r.truncated);
  }

  // Deletes all version history with the workspace; serialized so it can't race an in-flight commit.
  deleteRepo(workspaceId: string): Promise<void> {
    return this.serialize(workspaceId, () => rm(this.gitDirFor(workspaceId), { recursive: true, force: true }));
  }

  // Probes for the git binary: a missing one only shows up as code 1 with ENOENT, silently disabling snapshots.
  async isGitAvailable(): Promise<boolean> {
    const r = await this.git.run(["--version"]);
    return r.code === 0;
  }

  restore(workspaceId: string, workspaceDir: string, sha: string): Promise<boolean> {
    return this.serialize(workspaceId, async () => {
      const verify = await this.git.run([
        ...this.base(workspaceId, workspaceDir),
        "rev-parse",
        "--verify",
        `${sha}^{commit}`,
      ]);
      // Not logged: a stale restore point is a user error (the route answers 400). Only a failed reset is.
      if (verify.code !== 0) return false;
      const reset = await this.git.run([...this.base(workspaceId, workspaceDir), "reset", "--hard", sha]);
      if (reset.code !== 0) {
        log.error(
          {
            event: "workspace_restore_reset_failed",
            outcome: "workspace_not_restored",
            workspaceId,
            sha,
            stderr: reset.stderr,
          },
          "restore: reset failed",
        );
      } else {
        audit.info(
          {
            event: "workspace_restored",
            outcome: "workspace_files_restored",
            workspaceId,
            sha,
          },
          "workspace restored to snapshot",
        );
      }
      return reset.code === 0;
    });
  }
}
