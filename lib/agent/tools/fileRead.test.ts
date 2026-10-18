// A bare `cat` once let two tool calls exhaust the heap, beyond any try/catch, and the 50k dispatch cap ran
// too late. The fix stops bytes in the container, so these tests check the command issued.
import { describe, it, expect } from "vitest";
import { FileReadTool } from "./fileRead";
import type { ExecRunner, ExecResult } from "../interfaces";

function runnerReturning(result: Partial<ExecResult>): { runner: ExecRunner; cmds: string[][] } {
  const cmds: string[][] = [];
  const runner: ExecRunner = {
    exec: async (cmd) => {
      cmds.push(cmd);
      return { code: 0, stdout: "", stderr: "", ...result };
    },
  };
  return { runner, cmds };
}

const read = (tool: FileReadTool, args: Record<string, unknown>) =>
  (tool as unknown as { _call: (a: Record<string, unknown>) => Promise<string> })._call(args);

describe("FileReadTool capture limits", () => {
  it("bounds the read inside the container rather than cat-ing the whole file", async () => {
    const { runner, cmds } = runnerReturning({ stdout: "hello\n" });
    await read(new FileReadTool(runner), { file_path: "notes.txt" });

    // The whole point: an oversized file must never cross into this process to begin with.
    expect(cmds[0][0]).toBe("head");
    expect(cmds[0]).not.toContain("cat");
    expect(cmds[0]).toContain("/workspace/notes.txt");
  });

  it("returns a normal file unchanged, with no truncation noise", async () => {
    const { runner } = runnerReturning({ stdout: "alpha\nbeta" });
    const out = await read(new FileReadTool(runner), { file_path: "notes.txt" });

    expect(out).toBe("notes.txt\n1\talpha\n2\tbeta");
    expect(out).not.toContain("truncated");
  });

  it("flags an over-limit file and names the way to read the rest", async () => {
    // One byte past the ceiling is what the tool asks for, so this stands in for "bigger than the cap".
    const { runner } = runnerReturning({ stdout: "x".repeat(400_001) });
    const out = await read(new FileReadTool(runner), { file_path: "huge.log" });

    expect(out).toContain("file truncated at 400000 bytes");
    // Without a pointer to offset/limit the agent tends to retry the identical read and get nowhere.
    expect(out).toContain("offset:");
  });

  it("resumes ON the cut line, not past it", async () => {
    // The byte ceiling cut line 3 mid-way; resuming must point at offset 2, since 3 would skip the rest of line 3
    // silently, the very silence this notice prevents.
    const body = `alpha\nbeta\n${"g".repeat(400_000)}`;
    const { runner } = runnerReturning({ stdout: body });
    const out = await read(new FileReadTool(runner), { file_path: "huge.log" });

    expect(out).toContain("offset: 2 ");
    expect(out).toContain("re-read");
  });

  it("resumes on the cut line for a range read too", async () => {
    const { runner } = runnerReturning({ stdout: "line11\nline12\nline13", truncated: true });
    const out = await read(new FileReadTool(runner), { file_path: "huge.log", offset: 10, limit: 5 });

    // Rows shown are 0-based offsets 10, 11, 12; the cut one is 12.
    expect(out).toContain("offset: 12 ");
  });

  it("does not cry truncation for a file sitting exactly on the limit", async () => {
    const { runner } = runnerReturning({ stdout: "x".repeat(400_000) });
    const out = await read(new FileReadTool(runner), { file_path: "exact.log" });

    expect(out).not.toContain("truncated");
  });

  it("passes a range read through sed, and reports a ceiling hit on that path too", async () => {
    const { runner, cmds } = runnerReturning({ stdout: "line", truncated: true });
    const out = await read(new FileReadTool(runner), { file_path: "huge.log", offset: 10, limit: 5 });

    expect(cmds[0][0]).toBe("sed");
    // A range can still be unbounded — limit omitted, or a huge limit over very long lines.
    expect(out).toContain("file truncated");
  });
});
