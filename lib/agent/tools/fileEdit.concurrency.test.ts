// Regression tests for concurrent file mutations in PAODO-Workspaces.
// Verifies that mutations targeting the same file are serialized safely and updates survive,
// while mutations targeting different files run concurrently without blocking.

import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import type { ExecRunner } from "../interfaces";
import type { Logger } from "pino";

const requireFreeSpace = vi.hoisted(() => vi.fn());
vi.mock("@/lib/infra/storage/diskSpace", () => ({ requireFreeSpace }));

import { FileEditTool } from "./fileEdit";
import { FileWriteTool } from "./fileWrite";
import { KeyedAsyncLock } from "./fileLock";
import { dispatchTools, type RunnerTool } from "../toolDispatch";
import type { ResolvedToolCall } from "../modelTurn";

const WORKSPACE_DIR = os.tmpdir();

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mockLogger = {
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

beforeEach(() => {
  requireFreeSpace.mockReset();
  requireFreeSpace.mockResolvedValue(null);
});

describe("File mutation serialization — regression tests", () => {
  it("serializes concurrent edits to the same file so BOTH updates survive", async () => {
    let fileContent = "PORT=3000\nTIMEOUT=5000\n";
    const sharedLock = new KeyedAsyncLock();

    const runner: ExecRunner = {
      async exec(command: string[], opts?: { stdin?: string }) {
        const bin = command[0];
        if (bin === "cat") {
          return { code: 0, stdout: fileContent, stderr: "" };
        }
        if (bin === "tee") {
          fileContent = opts?.stdin ?? "";
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const toolA = new FileEditTool(runner, WORKSPACE_DIR, () => {}, sharedLock);
    const toolB = new FileEditTool(runner, WORKSPACE_DIR, () => {}, sharedLock);

    // Two edits dispatched concurrently against the same file
    const promiseA = toolA.invoke({
      file_path: "config.env",
      old_string: "PORT=3000",
      new_string: "PORT=8080",
    });

    const promiseB = toolB.invoke({
      file_path: "config.env",
      old_string: "TIMEOUT=5000",
      new_string: "TIMEOUT=10000",
    });

    const [resultA, resultB] = await Promise.all([promiseA, promiseB]);

    expect(resultA).toBe("Updated config.env");
    expect(resultB).toBe("Updated config.env");

    // BOTH edits survived!
    expect(fileContent).toContain("PORT=8080");
    expect(fileContent).toContain("TIMEOUT=10000");
    expect(fileContent).toBe("PORT=8080\nTIMEOUT=10000\n");

    // Lock map entry is cleaned up
    expect(sharedLock.activeKeysCount).toBe(0);
  });

  it("serializes concurrent edits when dispatched via dispatchTools (Promise.all in one agent turn)", async () => {
    let fileContent = "PORT=3000\nTIMEOUT=5000\n";
    const sharedLock = new KeyedAsyncLock();

    const runner: ExecRunner = {
      async exec(command: string[], opts?: { stdin?: string }) {
        const bin = command[0];
        if (bin === "cat") {
          return { code: 0, stdout: fileContent, stderr: "" };
        }
        if (bin === "tee") {
          fileContent = opts?.stdin ?? "";
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const tool = new FileEditTool(runner, WORKSPACE_DIR, () => {}, sharedLock);
    const runnerTool: RunnerTool = {
      name: "file_edit",
      invoke: (args) =>
        tool.invoke(args as { file_path: string; old_string: string; new_string: string; replace_all?: boolean }),
    };

    const calls: ResolvedToolCall[] = [
      {
        id: "call_1",
        name: "file_edit",
        args: { file_path: "config.env", old_string: "PORT=3000", new_string: "PORT=8080" },
      },
      {
        id: "call_2",
        name: "file_edit",
        args: { file_path: "config.env", old_string: "TIMEOUT=5000", new_string: "TIMEOUT=10000" },
      },
    ];

    const { settled } = dispatchTools(calls, { file_edit: runnerTool }, undefined, mockLogger);
    const results = await settled;

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe("ok");
    expect(results[1].status).toBe("ok");
    expect(results[0].resultStr).toBe("Updated config.env");
    expect(results[1].resultStr).toBe("Updated config.env");

    // Both updates survived in the target file
    expect(fileContent).toContain("PORT=8080");
    expect(fileContent).toContain("TIMEOUT=10000");
    expect(fileContent).toBe("PORT=8080\nTIMEOUT=10000\n");
    expect(sharedLock.activeKeysCount).toBe(0);
  });

  it("serializes concurrent file_edit and file_write to the same file safely", async () => {
    let fileContent = "PORT=3000\nTIMEOUT=5000\n";
    const sharedLock = new KeyedAsyncLock();

    const runner: ExecRunner = {
      async exec(command: string[], opts?: { stdin?: string }) {
        const bin = command[0];
        if (bin === "cat") {
          return { code: 0, stdout: fileContent, stderr: "" };
        }
        if (bin === "mkdir") {
          return { code: 0, stdout: "", stderr: "" };
        }
        if (bin === "tee") {
          fileContent = opts?.stdin ?? "";
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const editTool = new FileEditTool(runner, WORKSPACE_DIR, () => {}, sharedLock);
    const writeTool = new FileWriteTool(runner, WORKSPACE_DIR, () => {}, sharedLock);

    // Call write and edit concurrently
    const writePromise = writeTool.invoke({
      file_path: "config.env",
      content: "PORT=9999\nTIMEOUT=5000\n",
    });

    const editPromise = editTool.invoke({
      file_path: "config.env",
      old_string: "TIMEOUT=5000",
      new_string: "TIMEOUT=10000",
    });

    const [writeResult, editResult] = await Promise.all([writePromise, editPromise]);

    expect(writeResult).toContain("Written config.env");
    expect(editResult).toBe("Updated config.env");

    // Operations executed sequentially without torn state or unhandled errors
    expect(fileContent).toContain("TIMEOUT=10000");
    expect(sharedLock.activeKeysCount).toBe(0);
  });

  it("allows operations on DIFFERENT files to proceed concurrently without blocking", async () => {
    const sharedLock = new KeyedAsyncLock();
    const executionOrder: string[] = [];

    const file1Pause = createDeferred<void>();

    const runner: ExecRunner = {
      async exec(command: string[], _opts?: { stdin?: string }) {
        const bin = command[0];
        const targetPath = command[1];

        if (bin === "cat") {
          return { code: 0, stdout: "initial content", stderr: "" };
        }
        if (bin === "tee") {
          if (targetPath.includes("file1.txt")) {
            executionOrder.push("file1:paused");
            // Pause file1 while holding file1's lock
            await file1Pause.promise;
            executionOrder.push("file1:resumed");
          } else {
            executionOrder.push("file2:written");
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const tool = new FileEditTool(runner, WORKSPACE_DIR, () => {}, sharedLock);

    // Start edit on file1 (which will pause inside tee)
    const p1 = tool.invoke({
      file_path: "file1.txt",
      old_string: "initial",
      new_string: "updated-1",
    });

    // Wait until file1 is paused in its write
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(executionOrder).toContain("file1:paused");

    // Start edit on file2 — MUST NOT be blocked by file1!
    const p2 = tool.invoke({
      file_path: "file2.txt",
      old_string: "initial",
      new_string: "updated-2",
    });

    // file2 completes immediately while file1 is still paused
    const res2 = await p2;
    expect(res2).toBe("Updated file2.txt");
    expect(executionOrder).toContain("file2:written");
    expect(executionOrder).not.toContain("file1:resumed");

    // Now unblock file1
    file1Pause.resolve();
    const res1 = await p1;
    expect(res1).toBe("Updated file1.txt");
    expect(executionOrder).toContain("file1:resumed");

    expect(sharedLock.activeKeysCount).toBe(0);
  });

  it("releases the lock when an operation fails, allowing subsequent operations to proceed", async () => {
    let fileContent = "ORIGINAL_LINE\n";
    const sharedLock = new KeyedAsyncLock();

    const runner: ExecRunner = {
      async exec(command: string[], opts?: { stdin?: string }) {
        const bin = command[0];
        if (bin === "cat") {
          return { code: 0, stdout: fileContent, stderr: "" };
        }
        if (bin === "tee") {
          fileContent = opts?.stdin ?? "";
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const tool = new FileEditTool(runner, WORKSPACE_DIR, () => {}, sharedLock);

    // Call 1 fails because old_string is absent
    const failResult = await tool.invoke({
      file_path: "test.txt",
      old_string: "NON_EXISTENT_STRING",
      new_string: "REPLACEMENT",
    });

    expect(failResult).toContain("Error: old_string not found");
    // Lock was released!
    expect(sharedLock.activeKeysCount).toBe(0);

    // Call 2 on the same file succeeds immediately
    const successResult = await tool.invoke({
      file_path: "test.txt",
      old_string: "ORIGINAL_LINE",
      new_string: "NEW_LINE",
    });

    expect(successResult).toBe("Updated test.txt");
    expect(fileContent).toBe("NEW_LINE\n");
    expect(sharedLock.activeKeysCount).toBe(0);
  });

  it("preserves path validation and does not hold locks for invalid paths", async () => {
    const sharedLock = new KeyedAsyncLock();
    const runner: ExecRunner = {
      async exec() {
        return { code: 0, stdout: "", stderr: "" };
      },
    };

    const tool = new FileEditTool(runner, WORKSPACE_DIR, () => {}, sharedLock);

    const escapeResult = await tool.invoke({
      file_path: "../../outside.txt",
      old_string: "a",
      new_string: "b",
    });

    expect(escapeResult).toBe("Error: path is outside the workspace");
    expect(sharedLock.activeKeysCount).toBe(0);
  });
});
