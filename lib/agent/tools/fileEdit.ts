// file_edit: exact string replacement (first match, or all with replace_all); fails if absent or ambiguous.
// An empty old_string creates the file. Requires a prior file_read.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { containWorkspacePath } from "../pathUtils";
import { toolError } from "../toolUtils";
import { writeContainerFile } from "./containerWrite";
import { requireFreeSpace } from "@/lib/infra/storage/diskSpace";
import type { ExecRunner } from "../interfaces";

const schema = z.object({
  file_path: z.string().describe("File path relative to workspace root"),
  old_string: z.string().describe("Exact text to replace (empty string to create a new file)"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of just the first (default false)"),
});

export class FileEditTool extends StructuredTool<typeof schema> {
  name = "file_edit";
  description = `Edit a file by replacing an exact string. Use this instead of sed or awk.

- You MUST call file_read first. Editing a file you haven't read will produce wrong results.
- old_string must match exactly — including whitespace, indentation, and newlines.
- Fails if old_string appears more than once. Add more surrounding lines for uniqueness, or set replace_all: true.
- Set old_string to "" to create a new file (new_string becomes the full content).`;
  schema = schema;

  constructor(
    private runner: ExecRunner,
    private workspaceDir: string,
    private broadcast: (msg: string) => void,
  ) {
    super();
  }

  protected async _call({ file_path, old_string, new_string, replace_all }: z.infer<typeof schema>): Promise<string> {
    // Realpath containment (catches symlinks), resolved once for both branches.
    const relpath = await containWorkspacePath(this.workspaceDir, file_path);
    if (relpath === null) return "Error: path is outside the workspace";

    if (old_string === "") {
      // Create new file branch — same mkdir + write as file_write.
      const err = await writeContainerFile(this.runner, this.workspaceDir, relpath, new_string, this.broadcast);
      return err ?? `Created ${file_path}`;
    }

    // Edit existing file branch
    try {
      // stdout must NOT be trimmed (preserves trailing newlines for correct string matching)
      const readR = await this.runner.exec(["cat", `/workspace/${relpath}`]);
      if (readR.code !== 0) return `Error: ${readR.stderr || "file not found or unreadable"}`;

      const content = readR.stdout;
      if (!content.includes(old_string)) {
        return `Error: old_string not found in ${file_path}. Ensure exact match including whitespace and indentation.`;
      }
      const count = content.split(old_string).length - 1;
      if (count > 1 && !replace_all) {
        return `Error: old_string appears ${count} times. Add more surrounding lines to make it unique, or set replace_all: true.`;
      }
      const updated = replace_all
        ? content.replaceAll(old_string, new_string)
        : content.replace(old_string, new_string);

      const spaceErr = await requireFreeSpace(this.workspaceDir, Buffer.byteLength(updated));
      if (spaceErr) return spaceErr;

      const writeR = await this.runner.exec(["tee", `/workspace/${relpath}`], { stdin: updated });
      if (writeR.code !== 0) return `Error: ${writeR.stderr || "write failed"}`;
      this.broadcast(JSON.stringify({ type: "files_changed", paths: [relpath] }));
      return `Updated ${file_path}`;
    } catch (err: unknown) {
      return toolError(err);
    }
  }
}
