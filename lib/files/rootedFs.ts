// The only place a caller path becomes a host path. Each directory on the way is opened without following
// links and pinned by its descriptor, so a path component swapped for a link cannot redirect an operation.
import { constants, type Dirent, type Stats } from "fs";
import fs from "fs/promises";
import path from "path";
import { randomBytes } from "crypto";

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const OVERWRITE_FLAGS = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CREATE_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

// Linux reaches a child through the pinned descriptor, which no rename can redirect. Elsewhere (macOS dev)
// the joined path still refuses links at every step, but is not race-free.
const PINNED = process.platform === "linux";

/** Errors carry an errno-style `code` and the caller's relative path, never the host path. */
export class RootedFsError extends Error {
  constructor(
    readonly code: "ELOOP" | "EISDIR" | "ENOTREG" | "EINVAL",
    readonly relPath: string,
    message: string,
  ) {
    super(message);
    this.name = "RootedFsError";
  }
}

function symlinkError(relPath: string): RootedFsError {
  return new RootedFsError("ELOOP", relPath, `${relPath} is a symbolic link; the app does not follow links`);
}

function codeOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

// Lexical safety is the caller's job (relpath.ts); this is the backstop, since ".." through a pinned
// descriptor would walk straight out of the root.
function segmentsOf(relPath: string): string[] {
  if (relPath === "" || relPath === ".") return [];
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === ".." || segment.includes("\0") || segment.includes(path.sep)) {
      throw new RootedFsError("EINVAL", relPath, `${relPath} is not a plain relative path`);
    }
  }
  return segments;
}

function joinRel(relPath: string, name: string): string {
  return relPath === "" ? name : `${relPath}/${name}`;
}

/** A directory inside the root, held open so everything done through it stays in that directory. */
export class RootedDir {
  private constructor(
    private readonly handle: fs.FileHandle,
    private readonly hostPath: string,
    /** Root-relative POSIX path of this directory, "" for the root. */
    readonly relPath: string,
  ) {}

  // The root is the app's own path, so it may be reached through a link (macOS /var); nothing below it may.
  static async openRoot(rootDir: string): Promise<RootedDir> {
    const handle = await fs.open(rootDir, constants.O_RDONLY | constants.O_DIRECTORY);
    return new RootedDir(handle, rootDir, "");
  }

  /** Host path of a direct child, for one syscall that does not follow a final link. */
  childPath(name: string): string {
    if (segmentsOf(name).length !== 1) throw new RootedFsError("EINVAL", name, `${name} is not a single name`);
    return PINNED ? `/proc/self/fd/${this.handle.fd}/${name}` : path.join(this.hostPath, name);
  }

  private selfPath(): string {
    return PINNED ? `/proc/self/fd/${this.handle.fd}` : this.hostPath;
  }

  childRel(name: string): string {
    return joinRel(this.relPath, name);
  }

  async openDir(name: string): Promise<RootedDir> {
    const target = this.childPath(name);
    try {
      return new RootedDir(await fs.open(target, DIR_FLAGS), path.join(this.hostPath, name), this.childRel(name));
    } catch (err) {
      // Linux answers ENOTDIR for a link here, macOS ELOOP; lstat tells a link from a plain file.
      const code = codeOf(err);
      if (code === "ELOOP") throw symlinkError(this.childRel(name));
      if (code === "ENOTDIR" && (await this.isLink(name))) throw symlinkError(this.childRel(name));
      throw err;
    }
  }

  private async isLink(name: string): Promise<boolean> {
    return fs.lstat(this.childPath(name)).then(
      (stat) => stat.isSymbolicLink(),
      () => false,
    );
  }

  /** Never follows: a link reports as a link. */
  lstat(name: string): Promise<Stats> {
    return fs.lstat(this.childPath(name));
  }

  stat(): Promise<Stats> {
    return this.handle.stat();
  }

  /** Rejects with EACCES unless entries can be created and removed here. */
  assertWritable(): Promise<void> {
    return fs.access(this.selfPath(), constants.W_OK);
  }

  entries(): Promise<Dirent[]> {
    return fs.readdir(this.selfPath(), { withFileTypes: true });
  }

  /** Streams entries, for a listing that stops at a ceiling. The caller's loop closes it. */
  opendir() {
    return fs.opendir(this.selfPath());
  }

  // A regular file only, verified on the opened descriptor. O_NONBLOCK keeps a FIFO from hanging the open.
  async openFile(name: string, flags: number = READ_FLAGS): Promise<fs.FileHandle> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.childPath(name), flags);
    } catch (err) {
      if (codeOf(err) === "ELOOP") throw symlinkError(this.childRel(name));
      throw err;
    }
    try {
      const stat = await handle.stat();
      if (stat.isDirectory()) {
        throw new RootedFsError("EISDIR", this.childRel(name), `${this.childRel(name)} is a directory`);
      }
      if (!stat.isFile()) {
        throw new RootedFsError("ENOTREG", this.childRel(name), `${this.childRel(name)} is not a regular file`);
      }
      return handle;
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  /** Creates the file, failing with EEXIST if the name is taken by anything, a link included. */
  createFile(name: string, mode = 0o644): Promise<fs.FileHandle> {
    return fs.open(this.childPath(name), CREATE_FLAGS, mode);
  }

  /** Opens the child directory, creating it first if it is missing. */
  async ensureDir(name: string): Promise<RootedDir> {
    try {
      return await this.openDir(name);
    } catch (err) {
      if (codeOf(err) !== "ENOENT") throw err;
    }
    await fs.mkdir(this.childPath(name), { mode: 0o755 }).catch((err) => {
      if (codeOf(err) !== "EEXIST") throw err;
    });
    return this.openDir(name);
  }

  /** Removes a child of any kind. A link is unlinked, never descended. */
  async remove(name: string): Promise<void> {
    const target = this.childPath(name);
    if (!(await fs.lstat(target)).isDirectory()) return fs.unlink(target);
    let child: RootedDir;
    try {
      child = await this.openDir(name);
    } catch (err) {
      // Swapped for a link since the lstat: remove the link itself.
      if (err instanceof RootedFsError && err.code === "ELOOP") return fs.unlink(target);
      throw err;
    }
    try {
      for (const entry of await child.entries()) await child.remove(entry.name);
    } finally {
      await child.close();
    }
    await fs.rmdir(target);
  }

  close(): Promise<void> {
    return this.handle.close();
  }
}

// Walks to the directory at `relPath`, holding one descriptor at a time. `create` makes missing levels.
async function openAt(rootDir: string, segments: string[], create: boolean): Promise<RootedDir> {
  let dir = await RootedDir.openRoot(rootDir);
  try {
    for (const segment of segments) {
      const next = create ? await dir.ensureDir(segment) : await dir.openDir(segment);
      await dir.close();
      dir = next;
    }
    return dir;
  } catch (err) {
    await dir.close();
    throw err;
  }
}

/** Runs `fn` on the directory at `relPath` ("" for the root). */
export async function withDir<T>(rootDir: string, relPath: string, fn: (dir: RootedDir) => Promise<T>): Promise<T> {
  const dir = await openAt(rootDir, segmentsOf(relPath), false);
  try {
    return await fn(dir);
  } finally {
    await dir.close();
  }
}

// Runs `fn` on the parent directory of the entry at `relPath`, with the entry's own name. The root has no
// parent inside the root, so it is refused.
export async function withParent<T>(
  rootDir: string,
  relPath: string,
  fn: (parent: RootedDir, name: string) => Promise<T>,
  options: { createParents?: boolean } = {},
): Promise<T> {
  const segments = segmentsOf(relPath);
  const name = segments.pop();
  if (name === undefined) throw new RootedFsError("EINVAL", relPath, "The root is not an entry");
  const parent = await openAt(rootDir, segments, options.createParents === true);
  try {
    return await fn(parent, name);
  } finally {
    await parent.close();
  }
}

/** lstat of the entry at `relPath`; the root's own stat for "". */
export function statEntry(rootDir: string, relPath: string): Promise<Stats> {
  if (segmentsOf(relPath).length === 0) return withDir(rootDir, "", (dir) => dir.stat());
  return withParent(rootDir, relPath, (parent, name) => parent.lstat(name));
}

/** Opens a regular file for reading. The caller closes the handle. */
export function openFile(rootDir: string, relPath: string): Promise<fs.FileHandle> {
  return withParent(rootDir, relPath, (parent, name) => parent.openFile(name));
}

export async function readFile(rootDir: string, relPath: string): Promise<Buffer> {
  const handle = await openFile(rootDir, relPath);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** Replaces the content of an existing regular file in place. Never creates one. */
export async function overwriteFile(rootDir: string, relPath: string, content: string | Uint8Array): Promise<void> {
  const handle = await withParent(rootDir, relPath, (parent, name) => parent.openFile(name, OVERWRITE_FLAGS));
  try {
    await handle.truncate(0);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}

/** A file being written beside its destination; nothing is visible at `relPath` until `commit`. */
export interface PendingFile {
  handle: fs.FileHandle;
  /** Renames the finished file onto the destination, replacing a file or a link there. */
  commit(): Promise<void>;
  discard(): Promise<void>;
}

// Same `.part` naming the upload sweeper reclaims. The parent stays pinned until commit or discard, so
// the rename lands in the directory the walk reached.
export async function createPendingFile(rootDir: string, relPath: string, mode = 0o644): Promise<PendingFile> {
  const segments = segmentsOf(relPath);
  const name = segments.pop();
  if (name === undefined) throw new RootedFsError("EINVAL", relPath, "The root is not an entry");
  const parent = await openAt(rootDir, segments, true);
  const tmp = `${name}.${randomBytes(6).toString("hex")}.part`;
  let handle: fs.FileHandle;
  try {
    handle = await parent.createFile(tmp, mode);
  } catch (err) {
    await parent.close();
    throw err;
  }
  let settled = false;
  const finish = async (run: () => Promise<void>) => {
    if (settled) return;
    settled = true;
    try {
      await handle.close().catch(() => undefined);
      await run();
    } finally {
      await parent.close();
    }
  };
  return {
    handle,
    commit: () => finish(() => fs.rename(parent.childPath(tmp), parent.childPath(name))),
    discard: () => finish(() => fs.rm(parent.childPath(tmp), { force: true })),
  };
}

/** Writes a whole file, creating parents. A link at the destination is replaced, not written through. */
export async function writeFile(rootDir: string, relPath: string, content: Uint8Array): Promise<void> {
  const pending = await createPendingFile(rootDir, relPath);
  try {
    await pending.handle.writeFile(content);
    await pending.commit();
  } catch (err) {
    await pending.discard();
    throw err;
  }
}

/** Moves a file from outside the root (a staging directory) onto `relPath`, creating parents. */
export function adoptFile(rootDir: string, relPath: string, stagedHostPath: string): Promise<void> {
  return withParent(rootDir, relPath, (parent, name) => fs.rename(stagedHostPath, parent.childPath(name)), {
    createParents: true,
  });
}

/** mkdir -p inside the root. */
export async function ensureDir(rootDir: string, relPath: string): Promise<void> {
  await (await openAt(rootDir, segmentsOf(relPath), true)).close();
}

/** Creates one directory, failing with EEXIST if the name is taken. Parents must exist. */
export function createDir(rootDir: string, relPath: string): Promise<void> {
  return withParent(rootDir, relPath, (parent, name) => fs.mkdir(parent.childPath(name), { mode: 0o755 }));
}

export function removeEmptyDir(rootDir: string, relPath: string): Promise<void> {
  return withParent(rootDir, relPath, (parent, name) => fs.rmdir(parent.childPath(name)));
}

/** Removes the entry at `relPath`, recursively for a directory. */
export function removeEntry(rootDir: string, relPath: string): Promise<void> {
  return withParent(rootDir, relPath, (parent, name) => parent.remove(name));
}

export function unlinkEntry(rootDir: string, relPath: string): Promise<void> {
  return withParent(rootDir, relPath, (parent, name) => fs.unlink(parent.childPath(name)));
}

// Both parents are pinned for the one syscall; neither end follows a final link.
function withTwoParents<T>(
  rootDir: string,
  fromRel: string,
  toRel: string,
  fn: (fromPath: string, toPath: string) => Promise<T>,
): Promise<T> {
  return withParent(rootDir, fromRel, (fromParent, fromName) =>
    withParent(rootDir, toRel, (toParent, toName) => fn(fromParent.childPath(fromName), toParent.childPath(toName))),
  );
}

export function renameEntry(rootDir: string, fromRel: string, toRel: string): Promise<void> {
  return withTwoParents(rootDir, fromRel, toRel, (from, to) => fs.rename(from, to));
}

// Hard-links `fromRel` at `toRel`, failing with EEXIST if the destination name is taken. A link is refused:
// macOS would hard-link its target. Linux links the link itself, so a swap after the check is harmless.
export function linkEntry(rootDir: string, fromRel: string, toRel: string): Promise<void> {
  return withTwoParents(rootDir, fromRel, toRel, async (from, to) => {
    if ((await fs.lstat(from)).isSymbolicLink()) throw symlinkError(fromRel);
    await fs.link(from, to);
  });
}
