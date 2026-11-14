// Copies a workspace file or folder into a drive, host-side as raw bytes, one bounded file at a time.
// Drives are plain filesystems, so an existing path is overwritten and the result says so.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import { normalizeRelpath } from "../pathUtils";
import { openFile, statEntry, writeFile } from "@/lib/files/rootedFs";
import {
  resolveDrivePath,
  readHandleBounded,
  boundedReadError,
  enumerateDriveFolder,
  formatFolderTransfer,
  compactError,
} from "../driveAccess";
import { toolError } from "../toolUtils";
import { MAX_DRIVE_TRANSFER_BYTES } from "@/lib/infra/limits";

const schema = z.object({
  source_path: z.string().describe("Path of the workspace file or folder to upload (relative to workspace root)"),
  drive_name: z.string().describe("Drive to upload into, by name or id"),
  dest_path: z
    .string()
    .optional()
    .describe(
      "Destination path within the drive. For a file, defaults to its name at the drive root. For a folder, the destination directory the folder's contents land under; defaults to the folder's name.",
    ),
});

// The app reads the workspace from outside the container, where a link could point at anything.
function notFollowed(srcRel: string): string {
  return `Error: symbolic link not followed: ${srcRel}`;
}

export class DriveUploadTool extends StructuredTool<typeof schema> {
  name = "drive_upload";
  description = `Copy a file or a whole folder from your workspace into a shared drive so other agents can use it.
A folder is uploaded recursively, preserving its structure. If a file already exists at the destination it is overwritten (newest wins) and the result says so.
Symbolic links are never followed: a link is skipped and reported, so upload the real file it points to instead.`;
  schema = schema;

  constructor(
    private workspaceId: string,
    private workspaceDir: string,
  ) {
    super();
  }

  protected async _call({ source_path, drive_name, dest_path }: z.infer<typeof schema>): Promise<string> {
    const srcRel = normalizeRelpath(source_path);
    if (srcRel === null) return "Error: source path is outside the workspace";
    let stat;
    try {
      stat = await statEntry(this.workspaceDir, srcRel);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return `Error: workspace path not found: ${source_path}`;
      return code === "ELOOP" ? notFollowed(srcRel) : toolError(err);
    }
    if (stat.isSymbolicLink()) return notFollowed(srcRel);

    if (stat.isDirectory()) return this.uploadFolder(srcRel, drive_name, dest_path);

    const dest = dest_path?.trim() || path.posix.basename(srcRel);
    const put = await this.putFile(drive_name, dest, srcRel);
    if ("error" in put) return put.error;
    const where = `${put.relPath} in drive "${drive_name}"`;
    return put.existed
      ? `Uploaded ${where} — overwrote existing file (${put.bytes} bytes)`
      : `Uploaded ${where} (${put.bytes} bytes)`;
  }

  private async uploadFolder(srcRel: string, drive_name: string, dest_path?: string): Promise<string> {
    const destBase = dest_path?.trim().replace(/^\/+|\/+$/g, "") || path.posix.basename(srcRel);
    const files = await enumerateDriveFolder(this.workspaceDir, srcRel);
    if (!files.length) return `Error: "${srcRel}" holds no files to upload`;

    let moved = 0;
    let bytes = 0;
    const skipped: string[] = [];
    for (const rel of files) {
      const put = await this.putFile(drive_name, path.posix.join(destBase, rel), path.posix.join(srcRel, rel));
      if ("error" in put) {
        skipped.push(`${rel} (${compactError(put.error)})`);
        continue;
      }
      moved += 1;
      bytes += put.bytes;
    }
    return formatFolderTransfer("Uploaded", moved, bytes, `drive "${drive_name}"`, skipped);
  }

  private async putFile(
    drive_name: string,
    destRel: string,
    srcRel: string,
  ): Promise<{ bytes: number; relPath: string; existed: boolean } | { error: string }> {
    const resolved = resolveDrivePath(this.workspaceId, drive_name, destRel);
    if (typeof resolved === "string") return { error: resolved };
    if (!resolved.relPath) return { error: "Error: a destination file path within the drive is required" };

    const labels = {
      missing: `Error: workspace file not found: ${srcRel}`,
      isDirectory: `Error: "${srcRel}" is a directory, not a file`,
      advice: `Split it first (e.g. split -b 40m) and upload the parts.`,
    };
    // Same ceiling as drive_download: the workspace volume is read host-side, into the app's heap.
    // Opened without following a link, and read from that descriptor.
    let content: Buffer | string;
    try {
      const handle = await openFile(this.workspaceDir, srcRel);
      try {
        content = await readHandleBounded(handle, path.posix.basename(srcRel), MAX_DRIVE_TRANSFER_BYTES, labels);
      } finally {
        await handle.close();
      }
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP") return { error: notFollowed(srcRel) };
      if (code === "ENOTREG") return { error: `Error: "${srcRel}" is not a regular file` };
      return { error: boundedReadError(err, labels, srcRel) };
    }
    if (typeof content === "string") return { error: content };

    // The drive is reached without following a link too; a link at the destination is replaced.
    try {
      const existed = await statEntry(resolved.driveDir, resolved.relPath).then(
        () => true,
        (err: unknown) => {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw err;
        },
      );
      await writeFile(resolved.driveDir, resolved.relPath, content);
      return { bytes: content.length, relPath: resolved.relPath, existed };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ELOOP") return { error: `Error: destination runs through a symbolic link: ${resolved.relPath}` };
      return { error: toolError(err) };
    }
  }
}
