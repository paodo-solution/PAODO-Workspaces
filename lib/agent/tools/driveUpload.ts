// Copies a workspace file or folder into a drive, host-side as raw bytes, one bounded file at a time.
// Drives are plain filesystems, so an existing path is overwritten and the result says so.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import path from "path";
import fs from "fs/promises";
import { normalizeRelpath, resolveWorkspacePath } from "../pathUtils";
import {
  resolveDrivePath,
  readFileBounded,
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

// Names the workspace path, never the host path that Node's ELOOP message carries.
function resolveError(err: unknown, srcRel: string): string {
  return (err as NodeJS.ErrnoException).code === "ELOOP" ? `Error: symlink loop: ${srcRel}` : toolError(err);
}

export class DriveUploadTool extends StructuredTool<typeof schema> {
  name = "drive_upload";
  description = `Copy a file or a whole folder from your workspace into a shared drive so other agents can use it.
A folder is uploaded recursively, preserving its structure. If a file already exists at the destination it is overwritten (newest wins) and the result says so.`;
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
    let srcAbs: string | null;
    try {
      srcAbs = await resolveWorkspacePath(this.workspaceDir, srcRel);
    } catch (err: unknown) {
      return resolveError(err, srcRel);
    }
    if (srcAbs === null) return "Error: source path is outside the workspace";

    let stat;
    try {
      stat = await fs.stat(srcAbs);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return `Error: workspace path not found: ${source_path}`;
      return toolError(err);
    }

    if (stat.isDirectory()) return this.uploadFolder(srcRel, srcAbs, drive_name, dest_path);

    const dest = dest_path?.trim() || path.posix.basename(srcRel);
    const put = await this.putFile(drive_name, dest, srcRel);
    if ("error" in put) return put.error;
    const where = `${put.relPath} in drive "${drive_name}"`;
    return put.existed
      ? `Uploaded ${where} — overwrote existing file (${put.bytes} bytes)`
      : `Uploaded ${where} (${put.bytes} bytes)`;
  }

  private async uploadFolder(srcRel: string, srcAbs: string, drive_name: string, dest_path?: string): Promise<string> {
    const destBase = dest_path?.trim().replace(/^\/+|\/+$/g, "") || path.posix.basename(srcRel);
    const files = await enumerateDriveFolder(srcAbs);
    if (!files.length) return `Error: "${srcRel}" holds no files to upload`;

    let moved = 0;
    let bytes = 0;
    const skipped: string[] = [];
    for (const rel of files) {
      const put = await this.putFile(
        drive_name,
        path.posix.join(destBase, rel),
        path.posix.join(srcRel, rel),
      );
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
    // A symlink loop makes realpath throw; return it so a folder upload skips this file and continues.
    let containedSrc: string | null;
    try {
      containedSrc = await resolveWorkspacePath(this.workspaceDir, srcRel);
    } catch (err: unknown) {
      return { error: resolveError(err, srcRel) };
    }
    if (containedSrc === null) return { error: `Error: source path is outside the workspace: ${srcRel}` };

    const resolved = resolveDrivePath(this.workspaceId, drive_name, destRel);
    if (typeof resolved === "string") return { error: resolved };
    if (!resolved.relPath) return { error: "Error: a destination file path within the drive is required" };

    // Same ceiling as drive_download: the workspace volume is read host-side, into the app's heap.
    const content = await readFileBounded(containedSrc, MAX_DRIVE_TRANSFER_BYTES, {
      missing: `Error: workspace file not found: ${srcRel}`,
      isDirectory: `Error: "${srcRel}" is a directory, not a file`,
      advice: `Split it first (e.g. split -b 40m) and upload the parts.`,
    });
    if (typeof content === "string") return { error: content };

    const existed = await fs
      .access(resolved.absPath)
      .then(() => true)
      .catch(() => false);

    try {
      await fs.mkdir(path.dirname(resolved.absPath), { recursive: true });
      await fs.writeFile(resolved.absPath, content);
    } catch (err: unknown) {
      return { error: toolError(err) };
    }
    return { bytes: content.length, relPath: resolved.relPath, existed };
  }
}
