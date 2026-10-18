// drive_read: a drive file's text straight into context, read host-side. Binary files are refused with a
// pointer to drive_download, which also gives an editable copy.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { resolveDrivePath, readFileBounded } from "../driveAccess";
import { MAX_FILE_READ_BYTES } from "@/lib/infra/limits";

const schema = z.object({
  drive_name: z.string().describe("Drive to read from, by name or id"),
  path: z.string().describe("File path within the drive"),
});

export class DriveReadTool extends StructuredTool<typeof schema> {
  name = "drive_read";
  description = `Read a file's text content from a shared drive into your context.
Use this for a quick look. To get an editable copy in your workspace, use drive_download.`;
  schema = schema;

  constructor(private workspaceId: string) {
    super();
  }

  protected async _call({ drive_name, path: filePath }: z.infer<typeof schema>): Promise<string> {
    const resolved = resolveDrivePath(this.workspaceId, drive_name, filePath);
    if (typeof resolved === "string") return resolved;
    if (!resolved.relPath) return "Error: a file path within the drive is required";

    // Same ceiling as file_read, but refuses instead of truncating: there's no offset/limit to resume with.
    const buf = await readFileBounded(resolved.absPath, MAX_FILE_READ_BYTES, {
      missing: `Error: file not found in drive "${drive_name}"`,
      isDirectory: `Error: "${filePath}" is a directory, not a file`,
      advice: `Use drive_download to copy it into your workspace, then file_read with offset/limit to page through it.`,
    });
    if (typeof buf === "string") return buf;

    if (buf.subarray(0, 8000).includes(0)) {
      return `Error: "${filePath}" looks like a binary file and can't be read as text. Use drive_download to copy it into your workspace instead.`;
    }
    return buf.toString("utf-8");
  }
}
