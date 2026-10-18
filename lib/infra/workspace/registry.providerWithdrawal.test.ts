// Startup sweep for a withdrawn provider: clears all three model fields (stale ones would resurface if the
// name returns), persists once, touches nothing else. Temp-root harness like the other registry tests.
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceStore } from "./registry";
import type { Workspace } from "../../workspace/types";

let ROOT: string;
let make: (opts?: { persist?: (records: unknown[]) => void }) => WorkspaceStore;

beforeEach(async () => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wsstore-withdrawn-"));
  process.env.WORKSPACES_ROOT = ROOT;
  vi.resetModules();
  const mod = await import("./registry");
  make = (opts = {}) => new mod.WorkspaceStore({ persist: opts.persist ?? (() => {}) });
});

afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// Seeded into the backing map: createWorkspace never sets a model, so this state only arises by hydrating a
// registry written before the withdrawal.
function seed(store: WorkspaceStore, entries: Array<Partial<Workspace> & { id: string }>): void {
  for (const entry of entries) {
    (store as unknown as { workspaces: Map<string, Workspace> }).workspaces.set(entry.id, {
      name: entry.id,
      dir: path.join(ROOT, entry.id),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      maxIterations: 30,
      maxRunMinutes: 20,
      internetAccess: false,
      ...entry,
    } as Workspace);
  }
}

describe("clearWithdrawnLlmSelections", () => {
  it("clears provider, model and effort for a workspace on a withdrawn provider", () => {
    const store = make();
    seed(store, [{ id: "ws-1", llmProvider: "mistral", llmModel: "mistral-large", reasoningEffort: "high" }]);

    expect(store.clearWithdrawnLlmSelections(["anthropic", "openai"])).toEqual([
      { workspaceId: "ws-1", provider: "mistral" },
    ]);

    const cleared = store.getWorkspace("ws-1")!;
    expect(cleared.llmProvider).toBeUndefined();
    expect(cleared.llmModel).toBeUndefined();
    expect(cleared.reasoningEffort).toBeUndefined();
  });

  it("leaves workspaces on an offered provider, and every non-model field, alone", () => {
    const store = make();
    seed(store, [
      { id: "keeps", llmProvider: "openai", llmModel: "gpt-5", reasoningEffort: "high", description: "kept" },
      { id: "loses", llmProvider: "mistral", llmModel: "mistral-large", description: "also kept", maxIterations: 7 },
    ]);

    expect(store.clearWithdrawnLlmSelections(["openai"])).toEqual([{ workspaceId: "loses", provider: "mistral" }]);

    expect(store.getWorkspace("keeps")).toMatchObject({
      llmProvider: "openai",
      llmModel: "gpt-5",
      reasoningEffort: "high",
    });
    // The sweep is about the model choice and nothing else.
    expect(store.getWorkspace("loses")).toMatchObject({ description: "also kept", maxIterations: 7 });
  });

  it("does not touch a workspace that never picked", () => {
    const store = make();
    seed(store, [{ id: "never-picked" }]);
    expect(store.clearWithdrawnLlmSelections([])).toEqual([]);
  });

  it("writes the registry once for the whole batch, and not at all when nothing is stranded", () => {
    const persist = vi.fn();
    const store = make({ persist });
    seed(store, [
      { id: "a", llmProvider: "mistral", llmModel: "mistral-large" },
      { id: "b", llmProvider: "deepseek", llmModel: "deepseek-v4-flash" },
      { id: "c", llmProvider: "openai", llmModel: "gpt-5" },
    ]);

    expect(store.clearWithdrawnLlmSelections(["openai"])).toEqual([
      { workspaceId: "a", provider: "mistral" },
      { workspaceId: "b", provider: "deepseek" },
    ]);
    expect(persist).toHaveBeenCalledTimes(1);
    // The cleared fields are absent from what lands on disk, not merely from the live objects.
    const records = persist.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(records.map((r) => r.llmProvider)).toEqual([undefined, undefined, "openai"]);

    persist.mockClear();
    expect(store.clearWithdrawnLlmSelections(["openai"])).toEqual([]);
    expect(persist).not.toHaveBeenCalled();
  });

  // Startup refuses to serve on this, so the in-memory/disk divergence never outlives the process —
  // but it has to be reported rather than swallowed, or the next boot silently repeats the sweep.
  it("rethrows a failed registry write", () => {
    const store = make({
      persist: () => {
        throw new Error("disk full");
      },
    });
    seed(store, [{ id: "ws-1", llmProvider: "mistral", llmModel: "mistral-large" }]);
    expect(() => store.clearWithdrawnLlmSelections(["openai"])).toThrow("disk full");
  });
});
