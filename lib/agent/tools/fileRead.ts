// file_read: workspace file with cat -n line numbers, whole or a range (0-based offset). Must precede file_edit.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { normalizeRelpath } from "../pathUtils";
import { toolError } from "../toolUtils";
import type { ExecRunner } from "../interfaces";
import { MAX_FILE_READ_BYTES } from "../../infra/limits";

// Ceiling enforced in the container with `head -c`, so oversized files never arrive. skipResultCap is set,
// so this is the only bound; page past it with offset/limit.

const schema = z.object({
  file_path: z.string().describe("File path relative to workspace root"),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Line index to start from (0-based). Omit to start from the beginning."),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines to return. Omit to read to end of file."),
});

export class FileReadTool extends StructuredTool<typeof schema> {
  name = "file_read";
  readonly skipResultCap = true;
  description = `Read a file from the workspace. Returns content with line numbers (cat -n format).
Use this instead of cat, head, or tail.

- file_path is relative to the workspace root.
- Use offset + limit to read only part of a large file (e.g. offset:49, limit:50 reads lines 50–99).
- You MUST read a file with this tool before editing it with file_edit.`;
  schema = schema;

  constructor(private runner: ExecRunner) {
    super();
  }

  // Points at offset/limit so the agent doesn't retry the same read. Resumes AT the last line shown, since the
  // byte cut leaves it partial.
  private moreToRead(resumeOffset: number): string {
    return (
      `\n\n[file truncated at ${MAX_FILE_READ_BYTES} bytes — this is not the whole file]\n` +
      `Continue with file_read using offset: ${resumeOffset} (and a limit) to read on from here. ` +
      `That line is re-read because the cut landed in the middle of it.`
    );
  }

  protected async _call({ file_path, offset, limit }: z.infer<typeof schema>): Promise<string> {
    const relpath = normalizeRelpath(file_path);
    if (relpath === null) return "Error: path is outside the workspace";
    try {
      const header = `${file_path}\n`;

      if (offset === undefined && limit === undefined) {
        // One byte over the limit so a file exactly at it isn't reported as truncated.
        const r = await this.runner.exec(["head", "-c", String(MAX_FILE_READ_BYTES + 1), `/workspace/${relpath}`]);
        if (r.code !== 0) return `Error: ${r.stderr || "file not found or unreadable"}`;
        const truncated = Buffer.byteLength(r.stdout, "utf8") > MAX_FILE_READ_BYTES;
        const lines = r.stdout.split("\n");
        const numbered = header + lines.map((line, i) => `${i + 1}\t${line}`).join("\n");
        return truncated ? numbered + this.moreToRead(lines.length - 1) : numbered;
      } else {
        const startLine = (offset ?? 0) + 1;
        const endLine = limit !== undefined ? (offset ?? 0) + limit : "$";
        const r = await this.runner.exec(["sed", "-n", `${startLine},${endLine}p`, `/workspace/${relpath}`]);
        if (r.code !== 0) return `Error: ${r.stderr || "file not found or unreadable"}`;
        const start = offset ?? 0;
        const lines = r.stdout.split("\n");
        const numbered = header + lines.map((line, i) => `${start + i + 1}\t${line}`).join("\n");
        // A range can still be unbounded (limit omitted, or a huge limit over very long lines), in
        // which case the docker-client ceiling is what stopped it rather than a line count.
        return r.truncated ? numbered + this.moreToRead(start + lines.length - 1) : numbered;
      }
    } catch (err: unknown) {
      return toolError(err);
    }
  }
}
