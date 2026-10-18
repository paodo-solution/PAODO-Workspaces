// glob and list_directory read one `find` the docker client caps at 8MB. A cut listing looks complete, so
// both must say when it was cut, as file_read and git diff already do.
import { describe, it, expect } from "vitest";
import { GlobTool } from "./glob";
import { ListDirectoryTool } from "./listDirectory";
import type { ExecRunner, ExecResult } from "../interfaces";

function runnerReturning(result: Partial<ExecResult>): ExecRunner {
  return { exec: async () => ({ code: 0, stdout: "", stderr: "", ...result }) };
}

const call = (tool: GlobTool | ListDirectoryTool, args: Record<string, unknown>) =>
  (tool as unknown as { _call: (a: Record<string, unknown>) => Promise<string> })._call(args);

describe("listings that were cut short", () => {
  it("glob says the search stopped rather than implying it finished", async () => {
    const runner = runnerReturning({ stdout: "f\tsrc/a.ts\nf\tsrc/b.ts\n", truncated: true });

    const out = await call(new GlobTool(runner), { pattern: "src/*.ts" });

    expect(out).toContain("src/a.ts");
    expect(out).toContain("listing truncated");
  });

  it("glob distinguishes 'nothing matched' from 'we stopped looking'", async () => {
    const runner = runnerReturning({ stdout: "f\tsrc/a.js\n", truncated: true });

    const out = await call(new GlobTool(runner), { pattern: "**/*.ts" });

    // The dangerous read of a bare "No files matched." is that the agent concludes the file is absent
    // and goes off to create it.
    expect(out).toContain("No files matched.");
    expect(out).toContain("listing truncated");
  });

  it("glob stays quiet when the listing was whole", async () => {
    const runner = runnerReturning({ stdout: "f\tsrc/a.ts\n", truncated: false });

    expect(await call(new GlobTool(runner), { pattern: "src/*.ts" })).toBe("src/a.ts");
  });

  it("list_directory says so too", async () => {
    const runner = runnerReturning({ stdout: "1\tf\t1700000000\t/workspace\tnotes.txt\n", truncated: true });

    const out = await call(new ListDirectoryTool(runner), { dir_path: "." });

    expect(out).toContain("notes.txt");
    expect(out).toContain("listing truncated");
  });

  it("list_directory stays quiet when the listing was whole", async () => {
    const runner = runnerReturning({ stdout: "1\tf\t1700000000\t/workspace\tnotes.txt\n", truncated: false });

    expect(await call(new ListDirectoryTool(runner), { dir_path: "." })).not.toContain("truncated");
  });
});
