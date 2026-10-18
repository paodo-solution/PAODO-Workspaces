// drive_delete: removes a drive file or folder immediately, host-side. Drives have no history, so it's final.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import fs from "fs/promises";
import { resolveDrivePath } from "../driveAccess";
import { toolError } from "../toolUtils";

const schema = z.object({
  drive_name: z.string().describe("Drive to delete from, by name or id"),
  path: z.string().describe("File or folder path within the drive"),
});

export class DriveDeleteTool extends StructuredTool<typeof schema> {
  name = "drive_delete";
  description = `Delete a file or folder from a shared drive. This is permanent — there is no version history.`;
  schema = schema;

  constructor(private workspaceId: string) {
    super();
  }

  protected async _call({ drive_name, path: targetPath }: z.infer<typeof schema>): Promise<string> {
    const resolved = resolveDrivePath(this.workspaceId, drive_name, targetPath);
    if (typeof resolved === "string") return resolved;
    if (!resolved.relPath) return "Error: refusing to delete the drive root; specify a path";

    try {
      await fs.rm(resolved.absPath, { recursive: true, force: false });
      return `Deleted ${targetPath} from drive "${drive_name}"`;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return `Error: path not found in drive "${drive_name}"`;
      return toolError(e);
    }
  }
}
