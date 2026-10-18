// Errno picks the code, and the message names only the caller's relative path. libuv messages embed host
// paths, so real errnos are provoked on disk rather than faking `{ code: "EACCES" }`.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { fileSystemAppError, fileSystemCall } from "./errors";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "files-errno-test-"));
const WS_DIR = path.join(ROOT, "ws");

beforeEach(() => {
  fs.rmSync(WS_DIR, { recursive: true, force: true });
  fs.mkdirSync(WS_DIR, { recursive: true });
});

afterAll(() => {
  fs.chmodSync(WS_DIR, 0o755);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

/** The AppError a real filesystem call produced, or null if the call unexpectedly succeeded. */
async function failureOf(relPath: string, run: () => Promise<unknown>) {
  try {
    await fileSystemCall(relPath, run);
  } catch (err) {
    return err as { code?: string; message?: string; details?: unknown };
  }
  return null;
}

describe("fileSystemAppError", () => {
  it("maps a missing file to NOT_FOUND", async () => {
    const failure = await failureOf("notes.md", () => fsp.readFile(path.join(WS_DIR, "notes.md")));
    expect(failure).toMatchObject({ code: "NOT_FOUND", message: "notes.md does not exist" });
  });

  it("maps a directory read as a file to INVALID_REQUEST", async () => {
    fs.mkdirSync(path.join(WS_DIR, "src"));
    const failure = await failureOf("src", () => fsp.readFile(path.join(WS_DIR, "src")));
    expect(failure).toMatchObject({ code: "INVALID_REQUEST", message: "src is a directory, not a file" });
  });

  it("maps a permission failure to FILE_NOT_WRITABLE rather than FORBIDDEN", async () => {
    const target = path.join(WS_DIR, "locked.txt");
    fs.writeFileSync(target, "x");
    fs.chmodSync(target, 0o444);
    try {
      const failure = await failureOf("locked.txt", () => fsp.writeFile(target, "y"));
      // Not FORBIDDEN: 403 already means CSRF rejection in this app (requestGate.ts), so a read-only file
      // answering 403 would be indistinguishable from a request that was not allowed to be made.
      expect(failure).toMatchObject({ code: "FILE_NOT_WRITABLE", message: "locked.txt is not writable" });
    } finally {
      fs.chmodSync(target, 0o644);
    }
  });

  it("maps a path that runs through a file to INVALID_REQUEST", async () => {
    fs.writeFileSync(path.join(WS_DIR, "notes.txt"), "x");
    const failure = await failureOf("notes.txt/inner", () => fsp.readFile(path.join(WS_DIR, "notes.txt", "inner")));
    expect(failure).toMatchObject({ code: "INVALID_REQUEST", message: "notes.txt/inner is not a directory" });
  });

  it("names the field so a client can point at the argument that failed", async () => {
    const failure = await failureOf("notes.md", () => fsp.readFile(path.join(WS_DIR, "notes.md")));
    expect(failure?.details).toEqual({ field: "path" });
  });

  // THE test here: libuv appends the host path, and publishing it would expose the server's directory layout
  // on a surface meant to hide it.
  it("never carries the host path in the message, for any errno it recognises", async () => {
    const target = path.join(WS_DIR, "locked.txt");
    fs.writeFileSync(target, "x");
    fs.chmodSync(target, 0o444);

    const failures = [
      await failureOf("missing.txt", () => fsp.readFile(path.join(WS_DIR, "missing.txt"))),
      await failureOf("locked.txt", () => fsp.writeFile(target, "y")),
      await failureOf("locked.txt", () => fsp.readdir(target)),
    ];
    fs.chmodSync(target, 0o644);

    for (const failure of failures) {
      expect(failure?.message).toBeTruthy();
      expect(failure?.message).not.toContain(WS_DIR);
      expect(failure?.message).not.toContain(ROOT);
      expect(failure?.message).not.toContain(os.tmpdir());
    }
  });

  it("leaves an errno it has no public answer for unclassified, so the caller answers 500", () => {
    // Classifying everything as 4xx would report our bugs as user error, so an errno nobody has reasoned about
    // stays unclassified.
    expect(fileSystemAppError({ code: "EWHATEVER" }, "x.txt")).toBeNull();
    expect(fileSystemAppError({ code: "EDQUOT" }, "x.txt")).toBeNull();
    expect(fileSystemAppError({ code: "EMFILE" }, "x.txt")).toBeNull();
    expect(fileSystemAppError(new Error("not an errno at all"), "x.txt")).toBeNull();
    expect(fileSystemAppError(null, "x.txt")).toBeNull();
  });

  it("passes a non-errno failure through fileSystemCall untouched", async () => {
    const thrown = new Error("bug in our own code");
    await expect(fileSystemCall("x.txt", async () => Promise.reject(thrown))).rejects.toBe(thrown);
  });
});
