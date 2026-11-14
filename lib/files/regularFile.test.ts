// readRegularFile: only a regular file whose opened descriptor lies inside the root, links never followed.

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { NotRegularFileError, readRegularFile } from "./regularFile";

const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "regular-file-test-")));
const TREE = path.join(ROOT, "tree");
const OUTSIDE = path.join(ROOT, "outside");

beforeEach(() => {
  for (const dir of [TREE, OUTSIDE]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "canary-outside-91b3");
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("readRegularFile", () => {
  it("reads a regular file inside the root", async () => {
    fs.writeFileSync(path.join(TREE, "a.txt"), "hello");
    expect((await readRegularFile(TREE, path.join(TREE, "a.txt"))).toString()).toBe("hello");
  });

  it("refuses a final-component link", async () => {
    fs.symlinkSync(path.join(OUTSIDE, "secret.txt"), path.join(TREE, "link.txt"));
    await expect(readRegularFile(TREE, path.join(TREE, "link.txt"))).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it("refuses a file reached through a linked intermediate directory", async () => {
    fs.symlinkSync(OUTSIDE, path.join(TREE, "dir"));
    await expect(readRegularFile(TREE, path.join(TREE, "dir", "secret.txt"))).rejects.toBeInstanceOf(
      NotRegularFileError,
    );
  });

  it("refuses a directory", async () => {
    fs.mkdirSync(path.join(TREE, "sub"));
    await expect(readRegularFile(TREE, path.join(TREE, "sub"))).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it("passes through ENOENT for a missing file", async () => {
    await expect(readRegularFile(TREE, path.join(TREE, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
