// The coalescer commits a burst once, and a caller that knows it is done can force the commit; otherwise a slow
// transfer commits per gap, and a client exiting on its last response leaves it to an unwatched timer.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IWorkspaceSnapshotWriter } from "../interfaces";
import { snapshotWorkspaceCoalesced, flushSnapshotBurst } from "./snapshotWorkspace";

const WS = { id: "ws-1", dir: "/tmp/ws-1" };
const label = (changes: number, first: string) => (changes === 1 ? `uploaded ${first}` : `uploaded ${changes} files`);

function writer() {
  const commits: string[] = [];
  const versioning: IWorkspaceSnapshotWriter = {
    commitBaseline: async () => ({ sha: "base" }),
    commitResult: async (_id, _dir, summary) => {
      commits.push(summary);
      return { sha: `sha-${commits.length}`, changed: true };
    },
  };
  return { versioning, commits };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("snapshotWorkspaceCoalesced", () => {
  it("commits once for a burst, summarising the whole burst", async () => {
    const { versioning, commits } = writer();
    snapshotWorkspaceCoalesced(versioning, WS, "a.txt", label);
    snapshotWorkspaceCoalesced(versioning, WS, "b.txt", label);
    snapshotWorkspaceCoalesced(versioning, WS, "c.txt", label);
    expect(commits).toEqual([]);

    await vi.runAllTimersAsync();
    expect(commits).toEqual(["uploaded 3 files"]);
  });

  it("keeps a lone change's specific message", async () => {
    const { versioning, commits } = writer();
    snapshotWorkspaceCoalesced(versioning, WS, "notes.md", label);
    await vi.runAllTimersAsync();
    expect(commits).toEqual(["uploaded notes.md"]);
  });
});

describe("flushSnapshotBurst", () => {
  it("commits the pending burst immediately and awaits it", async () => {
    const { versioning, commits } = writer();
    snapshotWorkspaceCoalesced(versioning, WS, "a.txt", label);
    snapshotWorkspaceCoalesced(versioning, WS, "b.txt", label);

    expect(await flushSnapshotBurst(versioning, WS)).toBe(true);
    expect(commits).toEqual(["uploaded 2 files"]);
  });

  it("cancels the timer, so the flushed burst is not committed twice", async () => {
    const { versioning, commits } = writer();
    snapshotWorkspaceCoalesced(versioning, WS, "a.txt", label);
    await flushSnapshotBurst(versioning, WS);
    await vi.runAllTimersAsync();
    expect(commits).toEqual(["uploaded a.txt"]);
  });

  it("reports nothing pending rather than taking an empty snapshot", async () => {
    const { versioning, commits } = writer();
    expect(await flushSnapshotBurst(versioning, WS)).toBe(false);
    expect(commits).toEqual([]);
  });

  it("flushes only the named workspace", async () => {
    const { versioning, commits } = writer();
    const other = { id: "ws-2", dir: "/tmp/ws-2" };
    snapshotWorkspaceCoalesced(versioning, WS, "a.txt", label);
    snapshotWorkspaceCoalesced(versioning, other, "z.txt", label);

    await flushSnapshotBurst(versioning, WS);
    expect(commits).toEqual(["uploaded a.txt"]);

    await vi.runAllTimersAsync();
    expect(commits).toEqual(["uploaded a.txt", "uploaded z.txt"]);
  });
});
