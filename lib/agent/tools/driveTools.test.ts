// Binary fidelity: drive_upload and drive_download read and write raw bytes host-side, so binary
// files (SQLite, images) survive a round-trip; drive_read is text-only and refuses binary instead.
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "drivetools-test-"));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

// driveStore captures WORKSPACES_ROOT at module load, so point it at a clean temp dir and
// re-import the store (and the tools that depend on it) for each test.
async function freshModules() {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  process.env.WORKSPACES_ROOT = ROOT;
  vi.resetModules();
  const store = await import("@/lib/drives/store");
  const { DriveDownloadTool } = await import("./driveDownload");
  const { DriveReadTool } = await import("./driveRead");
  const { DriveUploadTool } = await import("./driveUpload");
  return { store, DriveDownloadTool, DriveReadTool, DriveUploadTool };
}

// A workspace dir the download tool can write into. It must exist, since the containment check
// realpaths the root before resolving the (not-yet-created) destination under it.
function seedWorkspace(): string {
  const workspaceDir = path.join(ROOT, "ws1");
  fs.mkdirSync(workspaceDir, { recursive: true });
  return workspaceDir;
}

type Mods = Awaited<ReturnType<typeof freshModules>>;
let mods: Mods;

beforeEach(async () => {
  mods = await freshModules();
});

// Create a connected drive and write a file into its content dir, returning the drive.
function seedDrive(name: string, file: string, bytes: Buffer) {
  const drive = mods.store.createDrive(name);
  mods.store.connectDrive(drive.id, "ws1");
  const abs = path.join(mods.store.driveContentDir(drive.id), file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  return drive;
}

describe("drive_download binary fidelity", () => {
  it("writes bytes host-side into the workspace without corruption", async () => {
    // Bytes that UTF-8 decoding would have destroyed: null, high bytes, a SQLite-ish header.
    const original = Buffer.concat([
      Buffer.from("SQLite format 3 ", "binary"),
      Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x00, 0x7f]),
    ]);
    seedDrive("dbdrive", "data.db", original);
    const workspaceDir = seedWorkspace();

    const tool = new mods.DriveDownloadTool("ws1", workspaceDir);
    const result = await tool.invoke({ drive_name: "dbdrive", path: "data.db" });

    const written = fs.readFileSync(path.join(workspaceDir, "downloads/dbdrive/data.db"));
    expect(written.equals(original)).toBe(true);
    expect(result).toContain("Downloaded");
    expect(result).toContain("to downloads/dbdrive/data.db");
  });

  it("reports the size in bytes, not chars", async () => {
    seedDrive("dbdrive", "data.db", Buffer.from([0x00, 0x01, 0x02]));
    const tool = new mods.DriveDownloadTool("ws1", seedWorkspace());
    const result = await tool.invoke({ drive_name: "dbdrive", path: "data.db" });
    expect(result).toContain("(3 bytes)");
    expect(result).not.toContain("chars");
  });
});

// The agent controls downloads/, so it can aim the app's write anywhere the app can write.
describe("drive_download symlink safety", () => {
  it("refuses a destination that runs through a symlinked downloads folder", async () => {
    seedDrive("data", "report.txt", Buffer.from("from the drive"));
    const workspaceDir = seedWorkspace();
    const outsideDir = path.join(ROOT, "download_target");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(workspaceDir, "downloads"));

    const result = await new mods.DriveDownloadTool("ws1", workspaceDir).invoke({
      drive_name: "data",
      path: "report.txt",
    });

    expect(result).toBe("Error: download destination escapes the workspace: downloads/data/report.txt");
    expect(fs.readdirSync(outsideDir)).toEqual([]);
  });

  it("replaces a symlink planted at the destination instead of writing through it", async () => {
    seedDrive("data", "report.txt", Buffer.from("from the drive"));
    const workspaceDir = seedWorkspace();
    const victim = path.join(ROOT, "victim.txt");
    fs.writeFileSync(victim, "ORIGINAL");
    fs.mkdirSync(path.join(workspaceDir, "downloads/data"), { recursive: true });
    fs.symlinkSync(victim, path.join(workspaceDir, "downloads/data/report.txt"));

    const result = await new mods.DriveDownloadTool("ws1", workspaceDir).invoke({
      drive_name: "data",
      path: "report.txt",
    });

    expect(result).toContain("Downloaded");
    expect(fs.readFileSync(victim, "utf8")).toBe("ORIGINAL");
    expect(fs.lstatSync(path.join(workspaceDir, "downloads/data/report.txt")).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(workspaceDir, "downloads/data/report.txt"), "utf8")).toBe("from the drive");
  });
});

describe("drive_read binary detection", () => {
  it("refuses a binary file and points to drive_download", async () => {
    seedDrive("dbdrive", "data.db", Buffer.from([0x00, 0x01, 0x02, 0x00]));
    const tool = new mods.DriveReadTool("ws1");
    const result = await tool.invoke({ drive_name: "dbdrive", path: "data.db" });
    expect(result).toMatch(/looks like a binary file/);
    expect(result).toContain("drive_download");
  });

  it("returns text content unchanged", async () => {
    const text = "hello\nworld\n";
    seedDrive("notes", "readme.txt", Buffer.from(text, "utf-8"));
    const tool = new mods.DriveReadTool("ws1");
    const result = await tool.invoke({ drive_name: "notes", path: "readme.txt" });
    expect(result).toBe(text);
  });
});

describe("drive_upload workspace containment and symlink safety", () => {
  it("uploads a regular file inside the workspace", async () => {
    seedDrive("data", "seed.txt", Buffer.from("seed"));
    const workspaceDir = seedWorkspace();
    const driveDir = mods.store.driveContentDir(mods.store.getDrivesForWorkspace("ws1")[0].id);
    fs.writeFileSync(path.join(workspaceDir, "regular.txt"), "regular content");

    const tool = new mods.DriveUploadTool("ws1", workspaceDir);
    const result = await tool.invoke({ source_path: "regular.txt", drive_name: "data" });

    expect(result).toContain("Uploaded");
    expect(result).toContain('regular.txt in drive "data"');
    expect(fs.readFileSync(path.join(driveDir, "regular.txt"), "utf-8")).toBe("regular content");
  });

  it("refuses to upload a file symlink pointing outside the workspace", async () => {
    seedDrive("data", "seed.txt", Buffer.from("seed"));
    const workspaceDir = seedWorkspace();
    const driveDir = mods.store.driveContentDir(mods.store.getDrivesForWorkspace("ws1")[0].id);

    const outsideFile = path.join(ROOT, "outside.txt");
    fs.writeFileSync(outsideFile, "outside secret");
    fs.symlinkSync(outsideFile, path.join(workspaceDir, "escaping.txt"));

    const tool = new mods.DriveUploadTool("ws1", workspaceDir);
    const result = await tool.invoke({ source_path: "escaping.txt", drive_name: "data" });

    expect(result).toBe("Error: symbolic link not followed: escaping.txt");
    expect(fs.existsSync(path.join(driveDir, "escaping.txt"))).toBe(false);
  });

  // One rule for every link: the app does not follow it, wherever it points.
  it("refuses a file symlink even when its target is inside the workspace", async () => {
    seedDrive("data", "seed.txt", Buffer.from("seed"));
    const workspaceDir = seedWorkspace();
    const driveDir = mods.store.driveContentDir(mods.store.getDrivesForWorkspace("ws1")[0].id);

    fs.writeFileSync(path.join(workspaceDir, "target.txt"), "target content");
    fs.symlinkSync(path.join(workspaceDir, "target.txt"), path.join(workspaceDir, "internal_link.txt"));

    const tool = new mods.DriveUploadTool("ws1", workspaceDir);
    const result = await tool.invoke({ source_path: "internal_link.txt", drive_name: "data" });

    expect(result).toBe("Error: symbolic link not followed: internal_link.txt");
    expect(fs.existsSync(path.join(driveDir, "internal_link.txt"))).toBe(false);
  });

  it("refuses a file reached through a symlinked directory", async () => {
    seedDrive("data", "seed.txt", Buffer.from("seed"));
    const workspaceDir = seedWorkspace();
    const driveDir = mods.store.driveContentDir(mods.store.getDrivesForWorkspace("ws1")[0].id);

    const outsideDir = path.join(ROOT, "outside_reach");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret");
    fs.symlinkSync(outsideDir, path.join(workspaceDir, "via"));

    const tool = new mods.DriveUploadTool("ws1", workspaceDir);
    const result = await tool.invoke({ source_path: "via/secret.txt", drive_name: "data" });

    expect(result).toBe("Error: symbolic link not followed: via/secret.txt");
    expect(fs.existsSync(path.join(driveDir, "via"))).toBe(false);
  });

  it("uploads safe files from a directory and skips an escaping symlink", async () => {
    seedDrive("data", "seed.txt", Buffer.from("seed"));
    const workspaceDir = seedWorkspace();
    const driveDir = mods.store.driveContentDir(mods.store.getDrivesForWorkspace("ws1")[0].id);

    const outsideFile = path.join(ROOT, "outside.txt");
    fs.writeFileSync(outsideFile, "outside secret");

    const folder = path.join(workspaceDir, "proj");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "safe.txt"), "safe content");
    fs.symlinkSync(outsideFile, path.join(folder, "leak.txt"));

    const tool = new mods.DriveUploadTool("ws1", workspaceDir);
    const result = await tool.invoke({ source_path: "proj", drive_name: "data" });

    expect(result).toContain("Uploaded 1 file");
    expect(result).toContain("Skipped 1: leak.txt (symbolic link not followed: proj/leak.txt)");
    expect(fs.readFileSync(path.join(driveDir, "proj/safe.txt"), "utf-8")).toBe("safe content");
    expect(fs.existsSync(path.join(driveDir, "proj/leak.txt"))).toBe(false);
  });

  it("uploads safe files from a directory and skips a nested directory symlink pointing outside", async () => {
    seedDrive("data", "seed.txt", Buffer.from("seed"));
    const workspaceDir = seedWorkspace();
    const driveDir = mods.store.driveContentDir(mods.store.getDrivesForWorkspace("ws1")[0].id);

    const outsideDir = path.join(ROOT, "outside_dir");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "external.txt"), "external secret content");

    const folder = path.join(workspaceDir, "parent_folder");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "safe.txt"), "safe content");
    fs.symlinkSync(outsideDir, path.join(folder, "nested_dir_link"));

    const tool = new mods.DriveUploadTool("ws1", workspaceDir);
    const result = await tool.invoke({ source_path: "parent_folder", drive_name: "data" });

    expect(result).toContain("Uploaded 1 file");
    expect(result).toContain("Skipped 1: nested_dir_link (symbolic link not followed: parent_folder/nested_dir_link)");
    expect(fs.readFileSync(path.join(driveDir, "parent_folder/safe.txt"), "utf-8")).toBe("safe content");
    expect(fs.existsSync(path.join(driveDir, "parent_folder/nested_dir_link"))).toBe(false);
    expect(fs.existsSync(path.join(driveDir, "parent_folder/nested_dir_link/external.txt"))).toBe(false);
  });

  it("refuses a top-level symlink pointing to an external directory", async () => {
    seedDrive("data", "seed.txt", Buffer.from("seed"));
    const workspaceDir = seedWorkspace();
    const driveDir = mods.store.driveContentDir(mods.store.getDrivesForWorkspace("ws1")[0].id);

    const outsideFolder = path.join(ROOT, "outside_folder");
    fs.mkdirSync(outsideFolder, { recursive: true });
    fs.writeFileSync(path.join(outsideFolder, "secret.txt"), "secret");
    fs.symlinkSync(outsideFolder, path.join(workspaceDir, "escaping_dir"));

    const tool = new mods.DriveUploadTool("ws1", workspaceDir);
    const result = await tool.invoke({ source_path: "escaping_dir", drive_name: "data" });

    expect(result).toBe("Error: symbolic link not followed: escaping_dir");
    expect(fs.existsSync(path.join(driveDir, "escaping_dir"))).toBe(false);
  });

  it("skips a self-referencing symlink in a folder and uploads the rest", async () => {
    seedDrive("data", "seed.txt", Buffer.from("seed"));
    const workspaceDir = seedWorkspace();
    const driveDir = mods.store.driveContentDir(mods.store.getDrivesForWorkspace("ws1")[0].id);

    const folder = path.join(workspaceDir, "proj");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "a.txt"), "a");
    fs.symlinkSync("loop.txt", path.join(folder, "loop.txt"));
    fs.writeFileSync(path.join(folder, "z.txt"), "z");

    const tool = new mods.DriveUploadTool("ws1", workspaceDir);
    const result = await tool.invoke({ source_path: "proj", drive_name: "data" });

    expect(result).toContain("Uploaded 2 files");
    expect(result).toContain("Skipped 1: loop.txt (symbolic link not followed: proj/loop.txt)");
    expect(result).not.toContain(workspaceDir);
    expect(fs.readFileSync(path.join(driveDir, "proj/a.txt"), "utf-8")).toBe("a");
    expect(fs.readFileSync(path.join(driveDir, "proj/z.txt"), "utf-8")).toBe("z");
  });

  it("returns an error instead of throwing for a top-level self-referencing symlink", async () => {
    seedDrive("data", "seed.txt", Buffer.from("seed"));
    const workspaceDir = seedWorkspace();
    fs.symlinkSync("loop.txt", path.join(workspaceDir, "loop.txt"));

    const tool = new mods.DriveUploadTool("ws1", workspaceDir);
    const result = await tool.invoke({ source_path: "loop.txt", drive_name: "data" });

    expect(result).toBe("Error: symbolic link not followed: loop.txt");
  });

  it("retains the existing error behavior for a missing file", async () => {
    seedDrive("data", "seed.txt", Buffer.from("seed"));
    const workspaceDir = seedWorkspace();

    const tool = new mods.DriveUploadTool("ws1", workspaceDir);
    const result = await tool.invoke({ source_path: "missing.txt", drive_name: "data" });

    expect(result).toBe("Error: workspace path not found: missing.txt");
  });
});
