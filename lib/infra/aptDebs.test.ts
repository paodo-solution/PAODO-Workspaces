// The saved set must be exactly what is installed: a stale version would be downgraded into a rebuilt
// container, and a file the index does not vouch for must never reach root.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { parseDebFileName, readAptDebIndex, storeCapturedDebs, verifyAptDebs, createDebStaging } from "./aptDebs";
import { workspaceAptDebsDir } from "./paths";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paodo-debs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function stage(files: string[]): Promise<string> {
  const dir = await createDebStaging("ws1", root);
  for (const file of files) await writeFile(path.join(dir, file), `deb:${file}`);
  return dir;
}

const pkg = (name: string, version: string, arch = "amd64") => ({ package: name, version, arch });

describe("parseDebFileName", () => {
  it("decodes apt's download names, epoch included", () => {
    expect(parseDebFileName("ffmpeg_7%3a6.1.1-3ubuntu5_amd64.deb")).toEqual(pkg("ffmpeg", "7:6.1.1-3ubuntu5"));
  });

  it("rejects anything that is not one of apt's file names", () => {
    expect(parseDebFileName("lock")).toBeNull();
    expect(parseDebFileName("../evil_1_amd64.deb")).toBeNull();
    expect(parseDebFileName("ffmpeg_1_amd64.deb.partial")).toBeNull();
  });
});

describe("storeCapturedDebs", () => {
  it("keeps installed versions with their hashes", async () => {
    const staging = await stage(["figlet_2.2.5-3_amd64.deb", "lock"]);

    const added = await storeCapturedDebs("ws1", staging, [pkg("figlet", "2.2.5-3")], root);

    expect(added).toEqual(["figlet:amd64"]);
    const index = readAptDebIndex("ws1", root);
    expect(index["figlet:amd64"]).toMatchObject({ file: "figlet_2.2.5-3_amd64.deb", version: "2.2.5-3" });
    expect(index["figlet:amd64"].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores downloads whose version is not the installed one", async () => {
    const staging = await stage(["figlet_2.2.4_amd64.deb"]);

    await storeCapturedDebs("ws1", staging, [pkg("figlet", "2.2.5-3")], root);

    expect(readAptDebIndex("ws1", root)).toEqual({});
  });

  it("replaces a superseded version and deletes its file", async () => {
    await storeCapturedDebs("ws1", await stage(["libx_1.0_amd64.deb"]), [pkg("libx", "1.0")], root);

    await storeCapturedDebs("ws1", await stage(["libx_1.1_amd64.deb"]), [pkg("libx", "1.1")], root);

    expect(readAptDebIndex("ws1", root)["libx:amd64"].version).toBe("1.1");
    const files = await readdir(workspaceAptDebsDir("ws1", root));
    expect(files.filter((f) => f.endsWith(".deb"))).toEqual(["libx_1.1_amd64.deb"]);
  });

  it("drops packages that are no longer installed, and keeps the rest", async () => {
    const first = await stage(["a_1_amd64.deb", "b_1_all.deb"]);
    await storeCapturedDebs("ws1", first, [pkg("a", "1"), pkg("b", "1", "all")], root);

    await storeCapturedDebs("ws1", await stage([]), [pkg("b", "1", "all")], root);

    expect(Object.keys(readAptDebIndex("ws1", root))).toEqual(["b:all"]);
  });
});

describe("verifyAptDebs", () => {
  it("passes an untouched set", async () => {
    await storeCapturedDebs("ws1", await stage(["a_1_amd64.deb"]), [pkg("a", "1")], root);

    const { debs, problems } = await verifyAptDebs("ws1", root);

    expect(debs).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it("flags a modified file", async () => {
    await storeCapturedDebs("ws1", await stage(["a_1_amd64.deb"]), [pkg("a", "1")], root);
    await writeFile(path.join(workspaceAptDebsDir("ws1", root), "a_1_amd64.deb"), "tampered");

    expect((await verifyAptDebs("ws1", root)).problems).toEqual(["a_1_amd64.deb: sha256 does not match the index"]);
  });

  it("flags an index entry that points outside the folder", async () => {
    const dir = workspaceAptDebsDir("ws1", root);
    await mkdir(dir, { recursive: true });
    const index = { "a:amd64": { ...pkg("a", "1"), file: "../a_1_amd64.deb", sha256: "x" } };
    await writeFile(path.join(dir, "index.json"), JSON.stringify(index));

    expect((await verifyAptDebs("ws1", root)).problems).toEqual(["../a_1_amd64.deb: not a .deb file name"]);
  });
});
