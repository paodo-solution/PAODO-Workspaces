// file_write: creates or overwrites a whole file (parents created), confined to the workspace. Prefer
// file_edit for targeted changes.

import { StructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { normalizeRelpath } from "../pathUtils";
import { writeContainerFile } from "./containerWrite";
import type { ExecRunner } from "../interfaces";
import { KeyedAsyncLock, getFileLockKey, workspaceFileLocks } from "./fileLock";

const schema = z.object({
  file_path: z.string().describe("File path relative to workspace root"),
  content: z.string().describe("Full content to write to the file"),
});

export class FileWriteTool extends StructuredTool<typeof schema> {
  name = "file_write";
  description = `Write full content to a file, creating or overwriting it.
ALWAYS use this when the user asks you to "write", "create", or "save" a file — never output the content as a code block in text.
Use for creating new files or complete rewrites. For targeted edits to existing files, prefer file_edit.
If the file already exists and you need to preserve or merge its content, read it first with file_read. If you are replacing it wholesale or creating a new file, skip the read.`;
  schema = schema;

  private lockManager: KeyedAsyncLock;

  constructor(
    private runner: ExecRunner,
    private workspaceDir: string,
    private broadcast: (msg: string) => void,
    lockManager?: KeyedAsyncLock,
  ) {
    super();
    this.lockManager = lockManager ?? workspaceFileLocks;
  }

  protected async _call({ file_path, content }: z.infer<typeof schema>): Promise<string> {
    // Lexical only: the write happens inside the container, which is the boundary for a link.
    const relpath = normalizeRelpath(file_path);
    if (relpath === null) return "Error: path is outside the workspace";

    const lockKey = getFileLockKey(this.workspaceDir, relpath);
    return this.lockManager.withLock(lockKey, async () => {
      const err = await writeContainerFile(this.runner, this.workspaceDir, relpath, content, this.broadcast);
      return err ?? `Written ${file_path} (${content.length} chars)`;
    });
  }
}
