// rootedFs: no operation follows a symbolic link, at the entry or on the way to it, wherever the link points.
// The race block (Linux only) swaps a directory for a link while operations run.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  adoptFile,
  createDir,
  createPendingFile,
  ensureDir,
  linkEntry,
  overwriteFile,
  readFile,
  removeEntry,
  renameEntry,
  statEntry,
  withDir,
  writeFile,
} from "./rootedFs";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rooted-fs-test-")));
const WS = path.join(ROOT, "ws");
const OUTSIDE = path.join(ROOT, "outside");
const SECRET = path.join(OUTSIDE, "secret.txt");
const ws = (rel: string) => path.join(WS, rel);

beforeEach(() => {
  fs.rmSync(WS, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  fs.mkdirSync(path.join(WS, "src"), { recursive: true });
  fs.mkdirSync(OUTSIDE);
  fs.writeFileSync(SECRET, "TOPSECRET");
  fs.writeFileSync(ws("src/a.txt"), "inside");
  // One link of each kind: to a file and to a directory, pointing out of the root and back into it.
  fs.symlinkSync(SECRET, ws("out-file"));
  fs.symlinkSync(OUTSIDE, ws("out-dir"));
  fs.symlinkSync(ws("src/a.txt"), ws("in-file"));
  fs.symlinkSync(ws("src"), ws("in-dir"));
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const codeOf = (run: () => Promise<unknown>) =>
  run().then(
    () => "no error",
    (err: NodeJS.ErrnoException) => err.code,
  );

const secretIntact = () => fs.readFileSync(SECRET, "utf8") === "TOPSECRET" && fs.statSync(SECRET).nlink === 1;

describe("ordinary paths", () => {
  it("reads, overwrites and stats a nested file", async () => {
    expect((await readFile(WS, "src/a.txt")).toString()).toBe("inside");
    await overwriteFile(WS, "src/a.txt", "changed");
    expect(fs.readFileSync(ws("src/a.txt"), "utf8")).toBe("changed");
    expect((await statEntry(WS, "src/a.txt")).isFile()).toBe(true);
    expect((await statEntry(WS, "")).isDirectory()).toBe(true);
  });

  it("writes a new file, creating its parents, and leaves no temp file", async () => {
    await writeFile(WS, "deep/er/new.txt", Buffer.from("new"));
    expect(fs.readFileSync(ws("deep/er/new.txt"), "utf8")).toBe("new");
    expect(fs.readdirSync(ws("deep/er"))).toEqual(["new.txt"]);
  });

  it("shows nothing at the destination until a pending file is committed, and nothing after a discard", async () => {
    const pending = await createPendingFile(WS, "src/big.bin");
    await pending.handle.writeFile("partial");
    expect(fs.existsSync(ws("src/big.bin"))).toBe(false);
    await pending.discard();
    expect(fs.readdirSync(ws("src"))).toEqual(["a.txt"]);
  });

  it("lists, renames, links and removes", async () => {
    expect(await withDir(WS, "src", async (dir) => (await dir.entries()).map((e) => e.name))).toEqual(["a.txt"]);
    await renameEntry(WS, "src/a.txt", "b.txt");
    await linkEntry(WS, "b.txt", "src/c.txt");
    expect(fs.readFileSync(ws("src/c.txt"), "utf8")).toBe("inside");
    await ensureDir(WS, "x/y/z");
    fs.writeFileSync(ws("x/y/z/f"), "f");
    await removeEntry(WS, "x");
    expect(fs.existsSync(ws("x"))).toBe(false);
  });

  it("reports the usual errnos", async () => {
    expect(await codeOf(() => readFile(WS, "missing.txt"))).toBe("ENOENT");
    expect(await codeOf(() => readFile(WS, "src"))).toBe("EISDIR");
    expect(await codeOf(() => readFile(WS, "src/a.txt/inner"))).toBe("ENOTDIR");
    expect(await codeOf(() => overwriteFile(WS, "missing.txt", "x"))).toBe("ENOENT");
    expect(await codeOf(() => createDir(WS, "src"))).toBe("EEXIST");
  });

  it("refuses a path that is not plain and relative, as a backstop to the lexical checks", async () => {
    for (const bad of ["../outside/secret.txt", "src/../../outside/secret.txt", "/etc/passwd", "src//a.txt", "./src"]) {
      expect(await codeOf(() => readFile(WS, bad))).toBe("EINVAL");
    }
  });

  it.skipIf(process.platform === "win32")("refuses a FIFO instead of blocking on it", async () => {
    const { execFileSync } = await import("child_process");
    execFileSync("mkfifo", [ws("pipe")]);
    expect(await codeOf(() => readFile(WS, "pipe"))).toBe("ENOTREG");
  });
});

describe("a link at the entry itself", () => {
  it.each(["out-file", "in-file", "out-dir", "in-dir"])("is not read: %s", async (link) => {
    expect(await codeOf(() => readFile(WS, link))).toBe("ELOOP");
  });

  it.each(["out-file", "in-file"])("is not written through by an overwrite: %s", async (link) => {
    expect(await codeOf(() => overwriteFile(WS, link, "PWNED"))).toBe("ELOOP");
    expect(secretIntact()).toBe(true);
    expect(fs.readFileSync(ws("src/a.txt"), "utf8")).toBe("inside");
  });

  it("is replaced, not written through, by a whole-file write", async () => {
    await writeFile(WS, "out-file", Buffer.from("new"));
    expect(fs.lstatSync(ws("out-file")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(ws("out-file"), "utf8")).toBe("new");
    expect(secretIntact()).toBe(true);
  });

  it("is reported as a link by stat, and is not listed as a directory", async () => {
    expect((await statEntry(WS, "out-dir")).isSymbolicLink()).toBe(true);
    expect(await codeOf(() => withDir(WS, "out-dir", (dir) => dir.entries()))).toBe("ELOOP");
    expect(await codeOf(() => withDir(WS, "in-dir", (dir) => dir.entries()))).toBe("ELOOP");
  });

  it("is removed as a link, leaving what it points at", async () => {
    await removeEntry(WS, "out-dir");
    await removeEntry(WS, "out-file");
    await removeEntry(WS, "in-dir");
    expect(fs.readdirSync(OUTSIDE)).toEqual(["secret.txt"]);
    expect(secretIntact()).toBe(true);
    expect(fs.existsSync(ws("src/a.txt"))).toBe(true);
  });

  it("is never hard-linked, which would put its target under a second name", async () => {
    expect(await codeOf(() => linkEntry(WS, "out-file", "copy"))).toBe("ELOOP");
    expect(fs.existsSync(ws("copy"))).toBe(false);
    expect(secretIntact()).toBe(true);
  });
});

describe("a link on the way to the entry", () => {
  it.each(["out-dir/secret.txt", "in-dir/a.txt"])("stops a read: %s", async (rel) => {
    expect(await codeOf(() => readFile(WS, rel))).toBe("ELOOP");
  });

  it("stops every kind of write", async () => {
    expect(await codeOf(() => writeFile(WS, "out-dir/new.txt", Buffer.from("x")))).toBe("ELOOP");
    expect(await codeOf(() => overwriteFile(WS, "out-dir/secret.txt", "PWNED"))).toBe("ELOOP");
    expect(await codeOf(() => ensureDir(WS, "out-dir/made"))).toBe("ELOOP");
    expect(await codeOf(() => createDir(WS, "out-dir/made"))).toBe("ELOOP");
    expect(await codeOf(() => createPendingFile(WS, "out-dir/up.bin"))).toBe("ELOOP");
    fs.writeFileSync(path.join(ROOT, "staged"), "staged");
    expect(await codeOf(() => adoptFile(WS, "out-dir/adopted", path.join(ROOT, "staged")))).toBe("ELOOP");
    expect(fs.readdirSync(OUTSIDE)).toEqual(["secret.txt"]);
    expect(secretIntact()).toBe(true);
  });

  it("stops a removal, a rename and a hard link", async () => {
    expect(await codeOf(() => removeEntry(WS, "out-dir/secret.txt"))).toBe("ELOOP");
    expect(await codeOf(() => renameEntry(WS, "out-dir/secret.txt", "stolen"))).toBe("ELOOP");
    expect(await codeOf(() => renameEntry(WS, "src/a.txt", "out-dir/planted"))).toBe("ELOOP");
    expect(await codeOf(() => linkEntry(WS, "out-dir/secret.txt", "stolen"))).toBe("ELOOP");
    expect(fs.existsSync(ws("stolen"))).toBe(false);
    expect(fs.readdirSync(OUTSIDE)).toEqual(["secret.txt"]);
    expect(secretIntact()).toBe(true);
  });

  it("does not descend a link while removing a directory", async () => {
    fs.mkdirSync(ws("doomed"));
    fs.symlinkSync(OUTSIDE, ws("doomed/link"));
    await removeEntry(WS, "doomed");
    expect(fs.existsSync(ws("doomed"))).toBe(false);
    expect(secretIntact()).toBe(true);
  });
});

// The attack the old check-then-reopen code lost: `flip` is a real directory one instant and a link to
// OUTSIDE the next. Only meaningful where children are reached through the pinned descriptor.
describe.runIf(process.platform === "linux")("while a directory is being swapped for a link", () => {
  const FLIPPER = `
    const fs = require("fs"), path = require("path");
    const [ws] = process.argv.slice(1);
    const flip = path.join(ws, "flip"), a = path.join(ws, "flip-real"), b = path.join(ws, "flip-link");
    for (;;) {
      try { fs.renameSync(flip, a); fs.renameSync(b, flip); } catch {}
      try { fs.renameSync(flip, b); fs.renameSync(a, flip); } catch {}
    }`;
  const RACE_MS = 1500;
  let flipper: ChildProcess;

  // Both sides hold the same names, so an operation that followed the link would find its target.
  beforeEach(() => {
    fs.mkdirSync(ws("flip"));
    fs.writeFileSync(ws("flip/data.txt"), "inside");
    fs.writeFileSync(path.join(OUTSIDE, "data.txt"), "TOPSECRET");
    fs.symlinkSync(OUTSIDE, ws("flip-link"));
    flipper = spawn(process.execPath, ["-e", FLIPPER, WS], { stdio: "ignore" });
  });

  afterEach(() => {
    flipper.kill("SIGKILL");
  });

  async function race(attempt: (i: number) => Promise<unknown>): Promise<number> {
    const deadline = Date.now() + RACE_MS;
    let attempts = 0;
    while (Date.now() < deadline) {
      await attempt(attempts).catch(() => undefined);
      attempts += 1;
    }
    return attempts;
  }

  const outsideUntouched = () => {
    expect(fs.readdirSync(OUTSIDE).sort()).toEqual(["data.txt", "secret.txt"]);
    expect(fs.readFileSync(path.join(OUTSIDE, "data.txt"), "utf8")).toBe("TOPSECRET");
    expect(fs.statSync(path.join(OUTSIDE, "data.txt")).nlink).toBe(1);
  };

  it("never reads the outside file", async () => {
    const seen = new Set<string>();
    const attempts = await race(async () => seen.add((await readFile(WS, "flip/data.txt")).toString()));
    expect(attempts).toBeGreaterThan(100);
    expect([...seen].filter((content) => content !== "inside")).toEqual([]);
  });

  it("never overwrites, creates, adopts or makes a directory outside", async () => {
    const staged = path.join(ROOT, "staged");
    await race(async (i) => {
      await overwriteFile(WS, "flip/data.txt", "inside").catch(() => undefined);
      await writeFile(WS, `flip/new-${i % 5}.txt`, Buffer.from("x")).catch(() => undefined);
      await ensureDir(WS, `flip/dir-${i % 5}/sub`).catch(() => undefined);
      fs.writeFileSync(staged, "x");
      await adoptFile(WS, `flip/adopted-${i % 5}`, staged).catch(() => undefined);
    });
    flipper.kill("SIGKILL");
    outsideUntouched();
  });

  it("never removes, renames away or hard-links the outside file", async () => {
    await race(async (i) => {
      await removeEntry(WS, "flip/data.txt").catch(() => undefined);
      await linkEntry(WS, "flip/data.txt", `stolen-${i}`).catch(() => undefined);
      await renameEntry(WS, "flip/data.txt", `moved-${i}`).catch(() => undefined);
      fs.writeFileSync(path.join(WS, "flip-real", "data.txt"), "inside", { flag: "w" });
    }).catch(() => undefined);
    flipper.kill("SIGKILL");
    outsideUntouched();
    for (const name of fs.readdirSync(WS).filter((n) => n.startsWith("stolen-") || n.startsWith("moved-"))) {
      expect(fs.readFileSync(ws(name), "utf8")).toBe("inside");
    }
  });
});
