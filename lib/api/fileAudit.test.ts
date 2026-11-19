// The audit line each file transfer or deletion leaves, named after the space it touched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { Readable } from "stream";
import tar from "tar-stream";
import { collectTransfer, packTransfer, TRANSFER_MEDIA_TYPE } from "@/lib/operations/files/transfer";

const lines = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("@/lib/infra/logger", async (original) => {
  const real = await original<typeof import("@/lib/infra/logger")>();
  return { ...real, createAuditLogger: () => ({ info: (fields: Record<string, unknown>) => lines.push(fields) }) };
});

const { getFileTransfer, putFileTransfer } = await import("./fileTransferRoutes");
const { deleteFileContent } = await import("./fileContentRoutes");

let root: string;
let ws: string;
beforeEach(() => {
  lines.length = 0;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "file-audit-"));
  ws = path.join(root, "ws");
  fs.mkdirSync(ws);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const workspace = () => ({ dir: ws, logContext: { workspaceId: "w1", route: "test" } });

async function tarOf(dir: string): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of packTransfer(await collectTransfer(dir, "."))) chunks.push(chunk as Buffer);
  return new Uint8Array(Buffer.concat(chunks));
}

describe("file audit lines", () => {
  it("logs a pull once the whole archive has gone out, with its files and bytes", async () => {
    fs.writeFileSync(path.join(ws, "a.md"), "hello");
    fs.mkdirSync(path.join(ws, "notes"));
    fs.writeFileSync(path.join(ws, "notes", "b.md"), "hi");
    const res = await getFileTransfer(new Request("http://x/files/transfer?path=."), workspace());
    expect(lines).toEqual([]);
    await res.arrayBuffer();
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual([
      expect.objectContaining({ event: "workspace_files_pulled", workspaceId: "w1", source: ".", files: 2, bytes: 7 }),
    ]);
  });

  it("logs a pull the client left part-way as aborted", async () => {
    fs.writeFileSync(path.join(ws, "a.md"), "hello");
    const res = await getFileTransfer(new Request("http://x/files/transfer?path=."), workspace());
    await res.body!.cancel();
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual([
      expect.objectContaining({ event: "workspace_files_pulled", outcome: "aborted", files: 1, bytes: 5 }),
    ]);
  });

  it("logs a push with what it created, overwrote and refused, and the snapshot it made", async () => {
    fs.writeFileSync(path.join(ws, "a.md"), "old");
    // Built by hand, as a client that does not filter would send it: node_modules is refused on arrival.
    const pack = tar.pack();
    pack.entry({ name: "payload", type: "directory" });
    pack.entry({ name: "payload/a.md" }, "new");
    pack.entry({ name: "payload/b.md" }, "b");
    pack.entry({ name: "payload/node_modules", type: "directory" });
    pack.entry({ name: "payload/node_modules/x.js" }, "x");
    pack.finalize();
    const chunks: Buffer[] = [];
    for await (const chunk of pack) chunks.push(chunk as Buffer);
    const req = new Request("http://x/files/transfer?dest=.", {
      method: "PUT",
      headers: { "content-type": TRANSFER_MEDIA_TYPE },
      body: Readable.toWeb(Readable.from([Buffer.concat(chunks)])) as ReadableStream,
      duplex: "half",
    } as RequestInit);
    const versioning = { beforeApply: async () => {}, commit: async () => "a1b2c3d4e5f6" as const };
    const res = await putFileTransfer(req, workspace(), versioning);
    expect(res.status).toBe(200);
    expect(lines).toEqual([
      expect.objectContaining({
        event: "workspace_files_pushed",
        dest: ".",
        created: 1,
        overwritten: 1,
        ignored: 2,
        snapshot: "a1b2c3d",
      }),
    ]);
  });

  it("logs a push whose snapshot could not be made, and names a drive by its own event", async () => {
    const src = path.join(root, "src");
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, "a.md"), "a");
    const put = async () =>
      new Request("http://x/files/transfer?dest=.", {
        method: "PUT",
        headers: { "content-type": TRANSFER_MEDIA_TYPE },
        body: Readable.toWeb(Readable.from([Buffer.from(await tarOf(src))])) as ReadableStream,
        duplex: "half",
      } as RequestInit);
    const failed = await putFileTransfer(await put(), workspace(), {
      beforeApply: async () => {},
      commit: async () => false,
    });
    expect(failed.status).toBe(500);
    expect(lines).toEqual([
      expect.objectContaining({ event: "workspace_files_pushed", outcome: "applied_without_snapshot", created: 1 }),
    ]);
    expect(lines[0]).not.toHaveProperty("snapshot");
    lines.length = 0;
    await putFileTransfer(await put(), { dir: ws, logContext: { driveId: "d1" } });
    expect(lines).toEqual([
      expect.objectContaining({ event: "drive_files_pushed", outcome: "succeeded", driveId: "d1" }),
    ]);
    expect(lines[0]).not.toHaveProperty("snapshot");
  });

  it("logs a deletion with the path and everything it took", async () => {
    fs.mkdirSync(path.join(ws, "notes"));
    fs.writeFileSync(path.join(ws, "notes", "a.md"), "a");
    fs.writeFileSync(path.join(ws, "notes", "b.md"), "b");
    const res = await deleteFileContent(
      new Request("http://x/files/content?path=notes", { method: "DELETE" }),
      workspace(),
    );
    expect(res.status).toBe(200);
    expect(lines).toEqual([expect.objectContaining({ event: "workspace_file_deleted", path: "notes", removed: 3 })]);
  });
});
