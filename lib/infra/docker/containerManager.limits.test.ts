// Caps can only be set at `docker run` and containers are never recreated, so a missing cap lasts forever.
// --pids-limit matters most: one fork bomb would exhaust the host's pid_max and stop every `docker exec`.
import { describe, it, expect } from "vitest";
import { ContainerManager } from "./containerManager";
import type { IDockerClient, DockerResult } from "./dockerClient";

const OK: DockerResult = { stdout: "", stderr: "", code: 0 };

// Nothing exists yet, so ensure() takes the full create path and issues `run`.
function makeDocker() {
  const calls: string[][] = [];
  const docker: IDockerClient = {
    cmd: async (...args: string[]): Promise<DockerResult> => {
      calls.push(args);
      if (args[0] === "inspect") return { stdout: "", stderr: "no such object", code: 1 };
      if (args[0] === "network" && args[1] === "inspect") return { stdout: "", stderr: "no such network", code: 1 };
      return OK;
    },
    build: async () => {},
    exec: async () => OK,
  };
  return { docker, calls };
}

async function runArgs(): Promise<string[]> {
  const { docker, calls } = makeDocker();
  await new ContainerManager(docker).ensure("ws1", "/w");
  // The container run, not the one-shot that seeds the agent home — only this one carries --name.
  return calls.find((c) => c[0] === "run" && c.includes("--name"))!;
}

describe("ContainerManager — workspace container resource caps", () => {
  it("caps the process count so a fork bomb cannot exhaust the host's PIDs", async () => {
    expect(await runArgs()).toContain("--pids-limit=512");
  });

  it("caps memory and CPU", async () => {
    const args = await runArgs();
    expect(args).toContain("--memory=1g");
    expect(args).toContain("--cpus=1.0");
  });
});
