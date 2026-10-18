// Signal-only: _call validates the target and acks, the runner restores (runner.test.ts). Pins the ack and
// the early sha-format guard.

import { describe, it, expect } from "vitest";
import { WorkspaceRestoreTool } from "./workspaceRestore";

const tool = () => new WorkspaceRestoreTool();

describe("WorkspaceRestoreTool", () => {
  it("requires a sha", async () => {
    // The cast is the point of the test: sha is required, so an LLM omitting it must be rejected by
    // the schema rather than reaching _call. TypeScript would otherwise refuse to express the case.
    await expect(tool().invoke({} as unknown as { sha: string })).rejects.toThrow(
      "Received tool input did not match expected schema",
    );
  });

  it("acks reverting to a specific snapshot when a sha is given", async () => {
    const out = await tool().invoke({ sha: "deadbee" });
    expect(out).toContain("deadbee");
    expect(out).toContain("Files only");
  });

  it("rejects a non-hex sha before signalling a restore", async () => {
    const out = await tool().invoke({ sha: "not a sha!" });
    expect(out).toContain("invalid sha");
  });
});
