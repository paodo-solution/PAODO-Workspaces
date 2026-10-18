// mkdir -p + `tee` write in the container for file_write and file_edit, then broadcasts files_changed so the
// tree updates at once. Returns null or an "Error:" string; `relpath` must already be normalized.
import path from "path";
import type { ExecRunner } from "../interfaces";
import { toolError } from "../toolUtils";
import { requireFreeSpace } from "@/lib/infra/storage/diskSpace";

export async function writeContainerFile(
  runner: ExecRunner,
  workspaceDir: string,
  relpath: string,
  content: string,
  broadcast: (msg: string) => void,
): Promise<string | null> {
  try {
    const spaceErr = await requireFreeSpace(workspaceDir, Buffer.byteLength(content));
    if (spaceErr) return spaceErr;

    const dirRelpath = path.posix.dirname(relpath);
    if (dirRelpath && dirRelpath !== ".") {
      const mkdirR = await runner.exec(["mkdir", "-p", `/workspace/${dirRelpath}`]);
      if (mkdirR.code !== 0) return `Error: could not create directory: ${mkdirR.stderr}`;
    }
    const writeR = await runner.exec(["tee", `/workspace/${relpath}`], { stdin: content });
    if (writeR.code !== 0) return `Error: ${writeR.stderr || "write failed"}`;
    broadcast(JSON.stringify({ type: "files_changed", paths: [relpath] }));
    return null;
  } catch (err) {
    return toolError(err);
  }
}
