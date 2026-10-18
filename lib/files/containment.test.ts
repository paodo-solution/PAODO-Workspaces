// resolveContained guards uploads and the agent's file tools. The key case is a symlink: a lexical check
// cannot see an in-tree dir pointing elsewhere, but comparing realpaths can.

import { describe, it, expect, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { resolveContained } from "./containment";

// realpath up front: macOS's tmpdir is itself a symlink (/var -> /private/var), and resolveContained
// realpaths the root, so a raw path would fail every assertion there.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "path-containment-test-")));
const WORKSPACE = path.join(ROOT, "workspace");
const OUTSIDE = path.join(ROOT, "outside");
fs.mkdirSync(WORKSPACE);
fs.mkdirSync(OUTSIDE);

afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("resolveContained", () => {
  it("resolves a plain relative path under the root", async () => {
    const resolved = await resolveContained(WORKSPACE, "notes.md");
    expect(resolved).toBe(path.join(WORKSPACE, "notes.md"));
  });

  it("resolves a nested path whose intermediate directories don't exist yet", async () => {
    const resolved = await resolveContained(WORKSPACE, "src/deep/new.ts");
    expect(resolved).toBe(path.join(WORKSPACE, "src/deep/new.ts"));
  });

  it("rejects a .. traversal", async () => {
    expect(await resolveContained(WORKSPACE, "../outside/escape.txt")).toBeNull();
  });

  it("rejects an absolute path outside the root", async () => {
    expect(await resolveContained(WORKSPACE, OUTSIDE + "/escape.txt")).toBeNull();
  });

  it("rejects a symlink whose real target is outside the root — the case a lexical-only check misses", async () => {
    const link = path.join(WORKSPACE, "escape-link");
    fs.symlinkSync(OUTSIDE, link);
    // "escape-link/payload.txt" is lexically inside WORKSPACE, but escape-link really points at
    // OUTSIDE — only realpath'ing the root and comparing resolved targets catches this.
    expect(await resolveContained(WORKSPACE, "escape-link/payload.txt")).toBeNull();
  });
});
