// Tests for the lexical workspace path guard (pathUtils.ts). Links are rootedFs.ts's job, tested there.

import { describe, it, expect } from "vitest";
import { normalizeRelpath, normalizeDirPath } from "./pathUtils";

// The agent can never address a path outside its workspace; every file tool routes through these. Tests
// assert behaviour (allowed or rejected), so they survive any reimplementation.

describe("normalizeRelpath — containment guard", () => {
  it("allows ordinary relative paths", () => {
    expect(normalizeRelpath("src/index.ts")).toBe("src/index.ts");
    expect(normalizeRelpath("a/b/c.txt")).toBe("a/b/c.txt");
  });

  it("collapses redundant segments to a clean relative path", () => {
    expect(normalizeRelpath("src/./a/../b.ts")).toBe("src/b.ts");
  });

  // --- the cases that matter: escapes MUST be rejected (null) ---

  it("rejects parent-directory traversal", () => {
    expect(normalizeRelpath("../secret")).toBeNull();
    expect(normalizeRelpath("a/../../etc/passwd")).toBeNull();
    expect(normalizeRelpath("..")).toBeNull();
  });

  it("rejects absolute paths", () => {
    expect(normalizeRelpath("/etc/passwd")).toBeNull();
    expect(normalizeRelpath("/")).toBeNull();
  });

  // The agent is told /workspace is its working directory and uses that form freely in shell
  // commands, so it reaches for it here too. It names the same file a relative path does.
  it("accepts the container's own /workspace form and returns it relative", () => {
    expect(normalizeRelpath("/workspace/hello.py")).toBe("hello.py");
    expect(normalizeRelpath("/workspace/src/index.ts")).toBe("src/index.ts");
    expect(normalizeRelpath("/workspace/src/./a/../b.ts")).toBe("src/b.ts");
  });

  it("rejects the workspace root itself, which is a directory and not a file", () => {
    expect(normalizeRelpath("/workspace")).toBeNull();
    expect(normalizeRelpath("/workspace/")).toBeNull();
  });

  // The prefix must match on a path boundary, and must be judged after normalization — otherwise
  // "/workspace/../etc/passwd" would trim to a path that reads as contained.
  it("rejects paths that only look like they start at the workspace root", () => {
    expect(normalizeRelpath("/workspacefoo/x")).toBeNull();
    expect(normalizeRelpath("/workspace-other/x")).toBeNull();
    expect(normalizeRelpath("/workspace/../etc/passwd")).toBeNull();
    expect(normalizeRelpath("/workspace/a/../../etc/passwd")).toBeNull();
  });
});

describe("normalizeDirPath — containment guard", () => {
  it("treats empty/current as the workspace root", () => {
    expect(normalizeDirPath(undefined)).toBe(".");
    expect(normalizeDirPath(".")).toBe(".");
  });

  it("allows ordinary subdirectories", () => {
    expect(normalizeDirPath("src/components")).toBe("src/components");
  });

  it("rejects escapes", () => {
    expect(normalizeDirPath("..")).toBeNull();
    expect(normalizeDirPath("../..")).toBeNull();
    expect(normalizeDirPath("/var")).toBeNull();
    expect(normalizeDirPath("/workspacefoo")).toBeNull();
    expect(normalizeDirPath("/workspace/../etc")).toBeNull();
  });

  // Unlike a file path, the root is a legitimate directory to name — it is the listing the agent
  // asks for most often, and "/workspace" is how the prompt spells it.
  it("accepts the container's own /workspace form, root included", () => {
    expect(normalizeDirPath("/workspace")).toBe(".");
    expect(normalizeDirPath("/workspace/")).toBe(".");
    expect(normalizeDirPath("/workspace/src/components")).toBe("src/components");
  });
});
