// Injected fakes must reach routes and tools with no Docker, and resetServices() must leave no trace in
// the production singletons.

import { describe, it, expect, afterEach } from "vitest";
import { WorkspaceStore, defaultWorkspaceStore } from "@/lib/infra/workspace/registry";
import type { Workspace } from "@/lib/workspace/types";
import { getStore, getContainers, setServices, resetServices } from "./services";
import type { IContainerManager } from "./interfaces";
import type { DockerResult } from "./docker/dockerClient";
import { FileReadTool } from "@/lib/agent/tools/fileRead";

const wsId = "inject-ws-id";
const ws: Workspace = {
  id: wsId,
  name: "inject-ws",
  dir: "/tmp/inject-ws",
  createdAt: new Date(),
  maxIterations: 30,
  maxRunMinutes: 5,
  internetAccess: true,
};

function fakeContainerManager(execCalls: string[][]): IContainerManager {
  const ok = (stdout: string): DockerResult => ({ stdout, stderr: "", code: 0 });
  return {
    ensure: async () => {},
    exec: async (_id, _dir, cmd) => {
      execCalls.push(cmd);
      return ok("hello from fake container\n");
    },
    execStreaming: async () => ({ code: 0 }),
    execAsRoot: async () => ok(""),
    openOutputSink: (_id, runId) => ({
      path: `/tmp/paodo-exec/${runId}.output`,
      limit: 50 * 1024 * 1024,
      truncated: false,
      write: () => {},
      close: () => {},
    }),
    startBackground: async () => ({ taskId: "fake-task", logFile: "/tmp/paodo-tasks/fake-task.output" }),
    stopBackground: async () => false,
    listBackground: () => [],
    listBackgroundLive: async () => [],
    reconcileBackgroundTasks: async () => [],
    stop: async () => {},
    remove: async () => {},
    applyInternetAccess: async () => {},
    reattachProxyNetworks: async () => {},
    resumeIdleReapers: async () => {},
    sweepManagedNetworks: async () => {},
    noteRunStart: () => {},
    noteRunEnd: () => {},
    deleteWorkspaceDir: async () => {},
    assertDockerAvailable: async () => {},
  };
}

function isolatedStore(): WorkspaceStore {
  return new WorkspaceStore({ map: new Map([[wsId, ws]]), persist: () => {} });
}

describe("service injection", () => {
  afterEach(() => resetServices());

  it("hands out the injected fakes", () => {
    const store = isolatedStore();
    const containers = fakeContainerManager([]);
    setServices({ store, containers });

    expect(getStore()).toBe(store);
    expect(getContainers()).toBe(containers);
    expect(getStore().getWorkspace(wsId)?.name).toBe("inject-ws");
  });

  it("runs a real file tool against the fake container instead of Docker", async () => {
    const execCalls: string[][] = [];
    const containers = fakeContainerManager(execCalls);
    setServices({ containers });

    // Mirrors how buildTools derives an ExecRunner from the container manager.
    const tool = new FileReadTool({ exec: (cmd, opts) => getContainers().exec(wsId, ws.dir, cmd, opts) });
    const result = await tool.invoke({ file_path: "greeting.txt" });

    expect(execCalls).toHaveLength(1);
    expect(result).toContain("hello from fake container");
  });

  it("never leaks into the production store, and resetServices() restores it", () => {
    setServices({ store: isolatedStore() });
    expect(defaultWorkspaceStore.getWorkspace(wsId)).toBeUndefined();

    resetServices();
    expect(getStore()).toBe(defaultWorkspaceStore);
  });
});
