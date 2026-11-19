import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeAll } from "vitest";
import type { DockerResult, IDockerClient } from "./dockerClient";
import { hashDockerfile } from "./dockerfileHasher";
import { ImageManager } from "./imageManager";

const IMAGE = "paodo-workspace";
const SOURCE = "ghcr.io/paodo-solution/paodo-workspaces-sandbox:1.0.0";
const ok = (stdout = ""): DockerResult => ({ stdout, stderr: "", code: 0 });
const fail = (stderr = "boom"): DockerResult => ({ stdout: "", stderr, code: 1 });

let dockerfile: string;
let hash: string;

beforeAll(async () => {
  dockerfile = join(await mkdtemp(join(tmpdir(), "imgmgr-")), "Dockerfile.workspace");
  await writeFile(dockerfile, "FROM ubuntu:24.04\n");
  hash = (await hashDockerfile(dockerfile))!;
});

// `images` maps an image name to its hash label; a missing key means the image is absent.
function fakeDocker(images: Record<string, string>, opts: { pull?: DockerResult; pulledLabel?: string } = {}) {
  const calls: string[][] = [];
  const builds: string[][] = [];
  const docker: IDockerClient = {
    cmd: async (...args) => {
      calls.push(args);
      if (args[0] === "image" && args[1] === "inspect") {
        const name = args[args.length - 1];
        if (!(name in images)) return fail("No such image");
        return args.includes("--format") ? ok(images[name]) : ok("[]");
      }
      if (args[0] === "pull") {
        const result = opts.pull ?? ok();
        if (result.code === 0) images[args[1]] = opts.pulledLabel ?? hash;
        return result;
      }
      if (args[0] === "tag") {
        images[args[2]] = images[args[1]];
        return ok();
      }
      return fail(`unexpected ${args.join(" ")}`);
    },
    exec: async () => ok(),
    build: async (buildArgs) => {
      builds.push(buildArgs);
    },
  };
  return { docker, calls, builds };
}

describe("ImageManager.ensureImage", () => {
  it("keeps an up-to-date image without pulling or building", async () => {
    const { docker, calls, builds } = fakeDocker({ [IMAGE]: hash });
    await new ImageManager(docker).ensureImage(IMAGE, dockerfile, SOURCE);
    expect(calls.some((c) => c[0] === "pull")).toBe(false);
    expect(builds).toHaveLength(0);
  });

  it("pulls and tags a matching prebuilt image instead of building", async () => {
    const { docker, calls, builds } = fakeDocker({});
    await new ImageManager(docker).ensureImage(IMAGE, dockerfile, SOURCE);
    expect(calls).toContainEqual(["pull", SOURCE]);
    expect(calls).toContainEqual(["tag", SOURCE, IMAGE]);
    expect(builds).toHaveLength(0);
  });

  it("replaces a stale image from the registry", async () => {
    const { docker, calls, builds } = fakeDocker({ [IMAGE]: "old-hash" });
    await new ImageManager(docker).ensureImage(IMAGE, dockerfile, SOURCE);
    expect(calls).toContainEqual(["tag", SOURCE, IMAGE]);
    expect(builds).toHaveLength(0);
  });

  it("builds when the pull fails", async () => {
    const { docker, calls, builds } = fakeDocker({}, { pull: fail("network unreachable") });
    await new ImageManager(docker).ensureImage(IMAGE, dockerfile, SOURCE);
    expect(calls.some((c) => c[0] === "tag")).toBe(false);
    expect(builds).toEqual([["build", "-t", IMAGE, "--label", `paodo.workspace-hash=${hash}`, "-"]]);
  });

  it("builds when the pulled image comes from a different Dockerfile", async () => {
    const { docker, calls, builds } = fakeDocker({}, { pulledLabel: "other-hash" });
    await new ImageManager(docker).ensureImage(IMAGE, dockerfile, SOURCE);
    expect(calls.some((c) => c[0] === "tag")).toBe(false);
    expect(builds).toHaveLength(1);
  });

  it("builds without pulling when no source is configured", async () => {
    const { docker, calls, builds } = fakeDocker({});
    await new ImageManager(docker).ensureImage(IMAGE, dockerfile);
    expect(calls.some((c) => c[0] === "pull")).toBe(false);
    expect(builds).toHaveLength(1);
  });
});
