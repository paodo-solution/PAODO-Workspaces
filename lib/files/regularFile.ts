// Reads a file in an agent-writable tree as a regular file inside `root`, checked on the open descriptor so
// swapping a path component for a link between check and read cannot redirect it.
import { constants } from "fs";
import fs from "fs/promises";
import path from "path";

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Thrown when the path is a link, a special file, or opens to something outside the root. */
export class NotRegularFileError extends Error {
  constructor(filePath: string) {
    super(`Not a regular file inside the tree: ${filePath}`);
    this.name = "NotRegularFileError";
  }
}

function isInside(realRoot: string, candidate: string): boolean {
  return candidate.startsWith(realRoot + path.sep);
}

// Linux names the opened file itself in /proc; elsewhere (macOS dev) fall back to realpath of the path.
async function openedPath(fd: number, filePath: string): Promise<string> {
  if (process.platform === "linux") return fs.readlink(`/proc/self/fd/${fd}`);
  return fs.realpath(filePath);
}

// `realRoot` must already be a realpath. Throws NotRegularFileError, or the open/read error (ENOENT etc.).
export async function readRegularFile(realRoot: string, filePath: string): Promise<Buffer> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, OPEN_FLAGS);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ELOOP") throw new NotRegularFileError(filePath);
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new NotRegularFileError(filePath);
    if (!isInside(realRoot, await openedPath(handle.fd, filePath))) throw new NotRegularFileError(filePath);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
