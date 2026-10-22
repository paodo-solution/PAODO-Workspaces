// The one channel for system packages: apt-get as root via execAsRoot, with names strictly validated and passed
// as argv (no shell, paths or .debs). Successes are recorded for replay (aptRecipe.ts).

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { PrivilegedRunner } from "../interfaces";
import { egressBlockMessage, type EgressPolicy } from "./egressBlock";

// name, or name=version. Lowercase apt package-name charset only; rejects `/`, spaces, and any
// shell metacharacter, which also blocks local-file (`./foo.deb`) installs.
const PKG_RE = /^[a-z0-9][a-z0-9+._-]*(=[a-zA-Z0-9+.:~-]+)?$/;

const schema = z.object({
  packages: z.array(z.string()).describe('apt package names to install, e.g. ["ffmpeg", "imagemagick"]'),
});

export class AptInstallTool extends StructuredTool<typeof schema> {
  name = "apt_install";
  description = `Install system packages (Debian/Ubuntu apt) into the workspace container.
Use this when a task needs a system-level tool or library that is not already installed and that
cannot be provided by npm/pip (e.g. ffmpeg, imagemagick, poppler-utils, a compiler toolchain extra).
The regular shell (execute_command) runs as a non-root user and CANNOT run apt-get — use this tool instead.
Provide bare package names (optionally pinned as name=version). Paths, URLs, and local .deb files are not allowed.
Node version managers (nvm) and Python (pyenv) and language package managers (npm, pip) still work from execute_command — only system packages go through this tool.`;
  schema = schema;

  // `record` saves installs for rebuilds (aptRecipe.ts). Injected, so the tool stays fs-free and can't
  // record against the wrong workspace.
  constructor(
    private runner: PrivilegedRunner,
    private record: (packages: string[]) => void,
    private egressPolicy?: () => EgressPolicy | undefined,
  ) {
    super();
  }

  protected async _call({ packages }: z.infer<typeof schema>): Promise<string> {
    if (!Array.isArray(packages) || packages.length === 0) {
      return "Error: provide one or more package names to install.";
    }
    const invalid = packages.filter((p) => !PKG_RE.test(p));
    if (invalid.length > 0) {
      return `Error: invalid package name(s): ${invalid.join(", ")}. Only apt package names (optionally name=version) are allowed.`;
    }

    try {
      const update = await this.runner.execAsRoot(["apt-get", "update"]);
      if (update.code !== 0) {
        return this.failure("apt-get update", update.stderr || update.stdout, update.stderr);
      }

      const install = await this.runner.execAsRoot([
        "apt-get",
        "install",
        "-y",
        "--no-install-recommends",
        ...packages,
      ]);
      if (install.code !== 0) {
        // apt-get update can exit 0 after a refused mirror, so its output is checked here too.
        return this.failure("apt-get install", install.stderr || install.stdout, `${update.stderr}\n${install.stderr}`);
      }
      // Only on success: a package that failed to install must not be replayed into every future
      // rebuild of this container, where it would fail again.
      this.record(packages);
      return `Installed: ${packages.join(", ")}\n${install.stdout}`.trim();
    } finally {
      await this.discardAptDownloads();
    }
  }

  private failure(step: string, output: string, stderr: string): string {
    const error = `Error: ${step} failed:\n${output}`;
    const note = egressBlockMessage(this.egressPolicy?.(), stderr);
    return note ? `${error}\n${note}` : error;
  }

  // Drops the .deb cache and package lists, which would otherwise pile up in long-lived containers.
  // Best-effort, and also runs after a failed install, since `update` may already have written lists.
  private async discardAptDownloads(): Promise<void> {
    try {
      await this.runner.execAsRoot(["/bin/sh", "-c", "apt-get clean; rm -rf /var/lib/apt/lists/*"]);
    } catch {
      // Ignore: the packages are installed and usable either way.
    }
  }
}
