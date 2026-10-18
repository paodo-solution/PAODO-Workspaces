import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import tar from "tar-stream";
import { AppError } from "@/lib/errors/appError";
import { collectTransfer, packTransfer, putTransfer } from "./transfer";

// Real ceilings admit a large tree, too big to build in a unit test; this one trips from a handful of
// entries while leaving the ordinary transfers here unaffected.
const ENTRY_CAP = 8;
const BYTE_CAP = 64;
vi.mock("@/lib/uploads/limits", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/uploads/limits")>()),
  MAX_TRANSFER_ENTRIES: 8,
  MAX_TRANSFER_BYTES: 64,
}));

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "file-transfer-operation-test-"));
const SOURCE = path.join(ROOT, "source");
const DEST = path.join(ROOT, "dest");

beforeEach(() => {
  fs.rmSync(SOURCE, { recursive: true, force: true });
  fs.rmSync(DEST, { recursive: true, force: true });
  fs.mkdirSync(SOURCE, { recursive: true });
  fs.mkdirSync(DEST, { recursive: true });
});

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

async function archive(entries: Array<{ name: string; type: "file" | "directory" | "symlink"; body?: Buffer }>) {
  const pack = tar.pack();
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      const header = {
        name: entry.name,
        type: entry.type,
        ...(entry.type === "file" ? { size: entry.body?.length ?? 0 } : {}),
        ...(entry.type === "symlink" ? { linkname: "../../outside" } : {}),
      };
      const done = (err?: Error | null) => (err ? reject(err) : resolve());
      if (entry.body) pack.entry(header, entry.body, done);
      else pack.entry(header, done);
    });
  }
  pack.finalize();
  // putTransfer takes a node:stream Readable, as the request body is; tar-stream's pack is streamx.
  return Readable.from(pack);
}

describe("tar transfers", () => {
  it("round-trips binary bytes and the executable distinction", async () => {
    fs.writeFileSync(path.join(SOURCE, "image.bin"), Buffer.from([0, 255, 1, 128]));
    fs.writeFileSync(path.join(SOURCE, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });

    const receipt = await putTransfer(DEST, "copied", packTransfer(await collectTransfer(SOURCE, ".")));

    expect(fs.readFileSync(path.join(DEST, "copied", "image.bin"))).toEqual(Buffer.from([0, 255, 1, 128]));
    expect(fs.statSync(path.join(DEST, "copied", "image.bin")).mode & 0o111).toBe(0);
    expect(fs.statSync(path.join(DEST, "copied", "run.sh")).mode & 0o111).not.toBe(0);
    expect(receipt.overwritten).toEqual([]);
  });

  it("merges a directory without deleting unrelated destination files and reports overwrites", async () => {
    fs.mkdirSync(path.join(DEST, "dist"));
    fs.writeFileSync(path.join(DEST, "dist", "keep.txt"), "keep");
    fs.writeFileSync(path.join(DEST, "dist", "app.js"), "old");
    fs.writeFileSync(path.join(SOURCE, "app.js"), "new");

    const receipt = await putTransfer(DEST, "dist", packTransfer(await collectTransfer(SOURCE, ".")));

    expect(fs.readFileSync(path.join(DEST, "dist", "keep.txt"), "utf8")).toBe("keep");
    expect(fs.readFileSync(path.join(DEST, "dist", "app.js"), "utf8")).toBe("new");
    expect(receipt.overwritten).toEqual(["dist/app.js"]);
  });

  it("applies the shared ignore contract during traversal", async () => {
    fs.mkdirSync(path.join(SOURCE, "node_modules"));
    fs.writeFileSync(path.join(SOURCE, "node_modules", "dependency.js"), "ignored");
    fs.writeFileSync(path.join(SOURCE, "main.js"), "included");

    await putTransfer(DEST, ".", packTransfer(await collectTransfer(SOURCE, ".")));

    expect(fs.existsSync(path.join(DEST, "main.js"))).toBe(true);
    expect(fs.existsSync(path.join(DEST, "node_modules"))).toBe(false);
  });

  it("refuses file/directory collisions before changing the destination", async () => {
    fs.writeFileSync(path.join(SOURCE, "entry"), "file");
    fs.mkdirSync(path.join(DEST, "entry"));
    fs.writeFileSync(path.join(DEST, "untouched"), "yes");

    await expect(putTransfer(DEST, ".", packTransfer(await collectTransfer(SOURCE, ".")))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(fs.readFileSync(path.join(DEST, "untouched"), "utf8")).toBe("yes");
  });

  it("rejects traversal and symlink entries from caller-authored archives", async () => {
    await expect(
      putTransfer(
        DEST,
        ".",
        await archive([
          { name: "payload", type: "directory" },
          { name: "payload/../../outside", type: "file", body: Buffer.from("bad") },
        ]),
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(fs.existsSync(path.join(ROOT, "outside"))).toBe(false);

    await expect(
      putTransfer(
        DEST,
        ".",
        await archive([
          { name: "payload", type: "directory" },
          { name: "payload/link", type: "symlink" },
        ]),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects a selected symlink rather than dereferencing it", async () => {
    fs.writeFileSync(path.join(SOURCE, "real.txt"), "secret");
    fs.symlinkSync("real.txt", path.join(SOURCE, "link.txt"));
    await expect(collectTransfer(SOURCE, "link.txt")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  // Containment passes this link (it points inside), so the push landed on its target, destroying a file the
  // receipt never named while reporting the link overwritten. Both directions must refuse.
  it("refuses a destination that resolves through a symlink rather than following it", async () => {
    fs.writeFileSync(path.join(SOURCE, "link.txt"), "new");
    fs.writeFileSync(path.join(DEST, "real.txt"), "secret");
    fs.symlinkSync("real.txt", path.join(DEST, "link.txt"));

    await expect(putTransfer(DEST, ".", packTransfer(await collectTransfer(SOURCE, ".")))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(fs.readFileSync(path.join(DEST, "real.txt"), "utf8")).toBe("secret");
  });

  // A directory link is the same defect one level up: the entries would land in the target directory
  // while every path in the receipt named the link.
  it("refuses a push into a symlinked destination directory", async () => {
    fs.writeFileSync(path.join(SOURCE, "app.js"), "new");
    fs.mkdirSync(path.join(DEST, "shared"));
    fs.symlinkSync("shared", path.join(DEST, "dist"));

    await expect(putTransfer(DEST, "dist", packTransfer(await collectTransfer(SOURCE, ".")))).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(fs.readdirSync(path.join(DEST, "shared"))).toEqual([]);
  });

  // A per-entry size limit bounds the bytes one transfer can land but says nothing about how many
  // inodes it consumes, and a whole-tree request has no per-file rate limit standing behind it.
  it("refuses a transfer carrying more entries than the cap, without applying any of it", async () => {
    const entries = [{ name: "payload", type: "directory" as const }];
    for (let i = 0; i < ENTRY_CAP + 2; i += 1) {
      entries.push({ name: `payload/f${i}.txt`, type: "file" as const, body: Buffer.from("x") } as never);
    }

    await expect(putTransfer(DEST, "landed", await archive(entries))).rejects.toMatchObject({
      code: "TRANSFER_TOO_LARGE",
      details: { limitEntries: ENTRY_CAP },
    });
    expect(fs.existsSync(path.join(DEST, "landed"))).toBe(false);
  });

  it("refuses a transfer over the total byte cap even when every file is individually allowed", async () => {
    await expect(
      putTransfer(
        DEST,
        "landed",
        await archive([
          { name: "payload", type: "directory" },
          { name: "payload/a.bin", type: "file", body: Buffer.alloc(BYTE_CAP) },
          { name: "payload/b.bin", type: "file", body: Buffer.alloc(BYTE_CAP) },
        ]),
      ),
    ).rejects.toMatchObject({ code: "TRANSFER_TOO_LARGE", details: { limitBytes: BYTE_CAP } });
    expect(fs.existsSync(path.join(DEST, "landed"))).toBe(false);
  });

  // The CLI hung on this archive, as destroy(err) never surfaced while extract waited on next(). Server-side the
  // same shape must fail the request, not hold the connection.
  it("refuses an archive whose first entry is a child, rather than stalling on it", async () => {
    await expect(
      putTransfer(DEST, ".", await archive([{ name: "payload/orphan.txt", type: "file", body: Buffer.from("x") }])),
    ).rejects.toBeInstanceOf(AppError);
  }, 5_000);

  // tar-stream's pack lacks readableHighWaterMark, so Readable.toWeb rejected it and every pull answered
  // INTERNAL_ERROR. Tests the route's real conversion, not just packTransfer → putTransfer.
  it("packs into a stream a Response can consume, the way the pull route serves it", async () => {
    fs.writeFileSync(path.join(SOURCE, "a.txt"), "a");
    fs.mkdirSync(path.join(SOURCE, "nested"));
    fs.writeFileSync(path.join(SOURCE, "nested", "b.bin"), Buffer.from([0, 255]));

    const body = Readable.toWeb(packTransfer(await collectTransfer(SOURCE, "."))) as ReadableStream<Uint8Array>;
    const received = Buffer.from(await new Response(body).arrayBuffer());

    // A tar is 512-byte blocks, and the payload has to survive the round trip through the web stream.
    expect(received.length).toBeGreaterThan(0);
    expect(received.length % 512).toBe(0);
    const applied = await putTransfer(DEST, "viaweb", Readable.from(received));
    expect(fs.readFileSync(path.join(DEST, "viaweb", "a.txt"), "utf-8")).toBe("a");
    expect(fs.readFileSync(path.join(DEST, "viaweb", "nested", "b.bin"))).toEqual(Buffer.from([0, 255]));
    expect(applied.created).toContain("viaweb/a.txt");
  });

  it("leaves no staging directory beside the workspace after a refused transfer", async () => {
    await expect(
      putTransfer(
        DEST,
        ".",
        await archive([
          { name: "payload", type: "directory" },
          { name: "payload/../../outside", type: "file", body: Buffer.from("bad") },
        ]),
      ),
    ).rejects.toBeInstanceOf(AppError);
    expect(fs.readdirSync(ROOT).filter((name) => name.startsWith(".paodo-transfer-"))).toEqual([]);
  });
});
