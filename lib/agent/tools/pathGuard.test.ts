// Proves every file tool WIRES the containment guard: an escaping path errors and never reaches runner.exec.
// execCommand has no path guard by design; its containment is the non-root sandbox.

import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import { FileReadTool } from "./fileRead";
import { FileWriteTool } from "./fileWrite";
import { FileEditTool } from "./fileEdit";
import type { ExecRunner } from "../interfaces";

// Write and edit also realpath-check a real workspaceDir, so this must exist. The OS temp dir always does,
// and nothing is written since runner.exec is mocked.
const WORKSPACE_DIR = os.tmpdir();

// Records every exec so we can assert it was NEVER called on an escaping path. Returns code 0 so
// the legitimate-path cases proceed far enough to issue at least one exec.
function makeRunner() {
  const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
  return { runner: { exec } as ExecRunner, exec };
}

const noopBroadcast = () => {};

// Must all be rejected: traversal, absolute, a path escaping only after `..` collapses, and two that borrow
// the root's name without starting at it.
const ESCAPING = [
  "../etc/passwd",
  "/etc/passwd",
  "foo/../../etc/passwd",
  "/workspacefoo/x",
  "/workspace/../etc/passwd",
];

// protected _call invoked directly — we are testing the guard, not zod/invoke wrapping.
type Callable = { _call(input: unknown): Promise<string> };
const callOf = (t: unknown) => (t as unknown as Callable)._call.bind(t);

describe("file tools wire the workspace containment guard", () => {
  let exec: ReturnType<typeof makeRunner>["exec"];
  let runner: ExecRunner;
  beforeEach(() => {
    ({ runner, exec } = makeRunner());
  });

  // A tool plus how to build its args from a path. fileEdit appears twice: its create and edit branches are
  // separate paths to exec, and both need the guard.
  const cases: { name: string; call: (filePath: string) => Promise<string> }[] = [
    { name: "file_read", call: (file_path) => callOf(new FileReadTool(runner))({ file_path }) },
    {
      name: "file_write",
      call: (file_path) => callOf(new FileWriteTool(runner, WORKSPACE_DIR, noopBroadcast))({ file_path, content: "x" }),
    },
    {
      name: "file_edit (edit branch)",
      call: (file_path) =>
        callOf(new FileEditTool(runner, WORKSPACE_DIR, noopBroadcast))({ file_path, old_string: "a", new_string: "b" }),
    },
    {
      name: "file_edit (create branch)",
      call: (file_path) =>
        callOf(new FileEditTool(runner, WORKSPACE_DIR, noopBroadcast))({ file_path, old_string: "", new_string: "b" }),
    },
  ];

  for (const { name, call } of cases) {
    describe(name, () => {
      for (const bad of ESCAPING) {
        it(`rejects "${bad}" without touching the container`, async () => {
          const result = await call(bad);
          expect(result).toMatch(/outside the workspace/i);
          expect(exec).not.toHaveBeenCalled();
        });
      }

      it("reaches the container for a legitimate relative path", async () => {
        await call("src/index.ts");
        expect(exec).toHaveBeenCalled();
      });

      // The prompt calls the working directory /workspace, so the agent addresses files that way.
      // The guard used to reject it alongside real escapes, costing a turn on every first write.
      it("reaches the container for the container's own /workspace form", async () => {
        await call("/workspace/src/index.ts");
        expect(exec).toHaveBeenCalled();
      });
    });
  }
});
