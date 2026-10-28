// Saved .debs are what make a rebuilt container whole whatever its internet setting: replay installs them
// with no network first, and only downloads what they did not cover.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paodo-aptdebs-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// WORKSPACES_ROOT is read at module load in paths.ts, so each test needs a fresh module graph.
async function load() {
  vi.resetModules();
  process.env.WORKSPACES_ROOT = root;
  process.env.WORKSPACES_VOLUME_NAME = "paodo_ws_workspaces";
  return {
    ContainerManager: (await import("./containerManager")).ContainerManager,
    transfer: await import("./aptDebsTransfer"),
    debs: await import("../aptDebs"),
  };
}

async function writeRecipe(packages: string[]) {
  await mkdir(path.join(root, ".homes", "ws1"), { recursive: true });
  await writeFile(path.join(root, ".homes", "ws1.apt.json"), JSON.stringify(packages));
  await writeFile(path.join(root, ".homes", "ws1.seeded"), "");
}

// Saves a set the way capture would, through the real store, so the index and hashes are genuine.
async function saveDebs(files: string[]) {
  const { debs } = await load();
  const staging = await debs.createDebStaging("ws1");
  for (const file of files) await writeFile(path.join(staging, file), `deb:${file}`);
  const installed = files.map((f) => debs.parseDebFileName(f)!);
  await debs.storeCapturedDebs("ws1", staging, installed);
  await rm(staging, { recursive: true, force: true });
}

// A container with a dpkg database and an apt download cache. Online installs land as version 1.0 and
// leave their .deb in the cache, the way apt does before `apt-get clean`.
function makeDocker(opts: { failUpdate?: boolean; failOfflineInstall?: boolean; imagePackages?: string[] } = {}) {
  const installed = new Map<string, string>();
  const cache = new Set<string>();
  const execs: string[][] = [];
  const cmds: string[][] = [];
  const line = (name: string, version: string) => `${name}\tamd64\t${version}\tinstall ok installed`;

  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      cmds.push(args);
      if (args[0] === "inspect" && args.includes("{{.Image}}")) return { ...OK, stdout: "sha256:old-image" };
      if (args[0] === "inspect") return { stdout: "", stderr: "no such object", code: 1 };
      if (args[0] === "network" && args[1] === "inspect") {
        if (args.includes("--format")) return { stdout: "paodo_ws_credproxy ", stderr: "", code: 0 };
        return { stdout: "", stderr: "no such network", code: 1 };
      }
      if (args[0] === "run" && args.includes("dpkg-query")) {
        return { ...OK, stdout: (opts.imagePackages ?? []).map((p) => line(p, "1.0")).join("\n") };
      }
      if (args[0] === "cp" && args[1].startsWith("ws_")) {
        for (const file of cache) await writeFile(path.join(args[2], file), `deb:${file}`);
      }
      return OK;
    },
    exec: async (_name: string, cmdArgs: string[]): Promise<DockerResult> => {
      execs.push(cmdArgs);
      const [bin, sub] = cmdArgs;
      if (bin === "dpkg-query") {
        const names = cmdArgs.slice(3);
        const rows = [...installed].filter(([n]) => names.length === 0 || names.includes(n));
        return { ...OK, stdout: rows.map(([n, v]) => line(n, v)).join("\n"), code: rows.length < names.length ? 1 : 0 };
      }
      if (bin === "find") return { ...OK, stdout: [...cache].join("\n") };
      if (bin === "apt-get" && sub === "update") return opts.failUpdate ? { ...OK, code: 100 } : OK;
      if (bin === "apt-get" && sub === "install") {
        const targets = cmdArgs.slice(4);
        if (targets[0]?.startsWith("/root/")) {
          if (opts.failOfflineInstall) return { ...OK, code: 100 };
          for (const t of targets) {
            const [n, v] = path.basename(t, ".deb").split("_");
            installed.set(n, decodeURIComponent(v));
          }
          return OK;
        }
        for (const t of cmdArgs.filter((a) => !a.startsWith("-") && a !== "apt-get" && a !== "install")) {
          const [n, v = "1.0"] = t.split("=");
          if (!cmdArgs.includes("--download-only")) installed.set(n, v);
          cache.add(`${n.split(":")[0]}_${v}_amd64.deb`);
        }
        return OK;
      }
      if (bin === "/bin/sh") cache.clear();
      return OK;
    },
    build: async () => {},
  };
  return { docker, execs, cmds, installed };
}

const deps = (internetAccess: boolean) => ({
  internetAccessFor: () => internetAccess,
  runEnvironment: () => ({ envArgs: [], hasProxyCA: false }),
  execEnvironment: () => ({}),
  installProxyCA: async () => {},
  ensureProxyRelay: async () => true,
});

const aptUpdate = (execs: string[][]) => execs.find((c) => c[0] === "apt-get" && c[1] === "update");
const offlineInstall = (execs: string[][]) =>
  execs.find((c) => c[0] === "apt-get" && c[1] === "install" && c.some((a) => a.startsWith("/root/.paodo-apt-debs/")));
const onlineInstalls = (execs: string[][]) =>
  execs.filter((c) => c[0] === "apt-get" && c[1] === "install" && !c.some((a) => a.startsWith("/root/")));

describe("replay installs the saved .debs with no network", () => {
  it("restores a workspace with internet off", async () => {
    await writeRecipe(["figlet"]);
    await saveDebs(["figlet_2.2.5-3_amd64.deb"]);
    const { ContainerManager } = await load();
    const { docker, execs, cmds, installed } = makeDocker();

    await new ContainerManager(docker, deps(false)).ensure("ws1", "/w");

    expect(cmds.some((c) => c[0] === "cp" && c[2] === "ws_ws1:/root/.paodo-apt-debs")).toBe(true);
    expect(offlineInstall(execs)).toContain("/root/.paodo-apt-debs/figlet_2.2.5-3_amd64.deb");
    expect(aptUpdate(execs)).toBeUndefined();
    expect(installed.get("figlet")).toBe("2.2.5-3");
  });

  it("removes the copied files afterwards", async () => {
    await writeRecipe(["figlet"]);
    await saveDebs(["figlet_2.2.5-3_amd64.deb"]);
    const { ContainerManager } = await load();
    const { docker, execs } = makeDocker();

    await new ContainerManager(docker, deps(false)).ensure("ws1", "/w");

    expect(execs).toContainEqual(["rm", "-rf", "/root/.paodo-apt-debs"]);
  });

  it("needs no download for an online workspace whose set is complete", async () => {
    await writeRecipe(["figlet"]);
    await saveDebs(["figlet_2.2.5-3_amd64.deb"]);
    const { ContainerManager } = await load();
    const { docker, execs } = makeDocker();

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    expect(aptUpdate(execs)).toBeUndefined();
    expect(onlineInstalls(execs)).toHaveLength(0);
  });

  it("never hands root a set that fails its hashes", async () => {
    await writeRecipe(["figlet"]);
    await saveDebs(["figlet_2.2.5-3_amd64.deb"]);
    await writeFile(path.join(root, ".homes", "ws1.apt-debs", "figlet_2.2.5-3_amd64.deb"), "tampered");
    const { ContainerManager } = await load();
    const { docker, execs, cmds } = makeDocker();

    await new ContainerManager(docker, deps(false)).ensure("ws1", "/w");

    expect(offlineInstall(execs)).toBeUndefined();
    expect(cmds.some((c) => c[0] === "cp" && c[2]?.startsWith("ws_"))).toBe(false);
  });
});

describe("replay downloads only what the saved set did not cover", () => {
  it("fetches the missing package alone, then saves it for next time", async () => {
    await writeRecipe(["figlet", "htop"]);
    await saveDebs(["figlet_2.2.5-3_amd64.deb"]);
    const { ContainerManager, debs } = await load();
    const { docker, execs } = makeDocker();

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    expect(onlineInstalls(execs)).toEqual([["apt-get", "install", "-y", "--no-install-recommends", "htop"]]);
    expect(Object.keys(debs.readAptDebIndex("ws1")).sort()).toEqual(["figlet:amd64", "htop:amd64"]);
  });

  it("falls back to downloading everything when the offline install fails", async () => {
    await writeRecipe(["figlet"]);
    await saveDebs(["figlet_2.2.5-3_amd64.deb"]);
    const { ContainerManager } = await load();
    const { docker, execs } = makeDocker({ failOfflineInstall: true });

    await new ContainerManager(docker, deps(true)).ensure("ws1", "/w");

    expect(onlineInstalls(execs)).toEqual([["apt-get", "install", "-y", "--no-install-recommends", "figlet"]]);
  });

  it("does not try to download for a workspace with internet off", async () => {
    await writeRecipe(["figlet", "htop"]);
    await saveDebs(["figlet_2.2.5-3_amd64.deb"]);
    const { ContainerManager } = await load();
    const { docker, execs, installed } = makeDocker();

    await expect(new ContainerManager(docker, deps(false)).ensure("ws1", "/w")).resolves.toBeUndefined();

    expect(aptUpdate(execs)).toBeUndefined();
    expect(installed.has("figlet")).toBe(true);
  });
});

describe("apt_install saves the .debs it downloaded", () => {
  it("captures only the installed versions", async () => {
    const { ContainerManager, debs } = await load();
    const { docker, installed } = makeDocker();
    const manager = new ContainerManager(docker, deps(true));
    await docker.exec("ws_ws1", ["apt-get", "install", "-y", "--no-install-recommends", "ffmpeg"]);
    installed.set("ffmpeg", "2.0");

    await manager.captureAptDebs("ws1");

    expect(debs.readAptDebIndex("ws1")).toEqual({});
  });

  it("never rejects, even when the container cannot be read", async () => {
    const { ContainerManager } = await load();
    const { docker } = makeDocker();
    docker.exec = async () => {
      throw new Error("docker daemon went away");
    };

    await expect(new ContainerManager(docker, deps(true)).captureAptDebs("ws1")).resolves.toBeUndefined();
  });
});

describe("backfill saves what an existing container already has", () => {
  it("re-downloads exactly the packages its own image lacks", async () => {
    const { transfer, debs } = await load();
    const { docker, execs, cmds, installed } = makeDocker({ imagePackages: ["bash"] });
    installed.set("bash", "1.0");
    installed.set("figlet", "1.0");

    const report = await transfer.backfillDebs(docker, "ws1");

    expect(cmds).toContainEqual(expect.arrayContaining(["run", "--rm", "--network", "none", "sha256:old-image"]));
    expect(execs).toContainEqual([
      "apt-get",
      "install",
      "--reinstall",
      "--download-only",
      "-y",
      "--no-install-recommends",
      "figlet:amd64=1.0",
    ]);
    expect(report).toEqual({ saved: ["figlet:amd64=1.0"], failed: [] });
    expect(Object.keys(debs.readAptDebIndex("ws1"))).toEqual(["figlet:amd64"]);
  });

  it("never removes or recreates the container", async () => {
    const { transfer } = await load();
    const { docker, cmds, installed } = makeDocker();
    installed.set("figlet", "1.0");

    await transfer.backfillDebs(docker, "ws1");

    expect(cmds.some((c) => c[0] === "rm" || c[0] === "create" || (c[0] === "run" && !c.includes("--rm")))).toBe(false);
  });

  it("reports a missing route instead of saving nothing silently", async () => {
    const { transfer } = await load();
    const { docker, installed } = makeDocker({ failUpdate: true });
    installed.set("figlet", "1.0");

    await expect(transfer.backfillDebs(docker, "ws1")).rejects.toThrow(/does the workspace have internet/);
  });
});
