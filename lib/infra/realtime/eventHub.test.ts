// The hub every change event goes through: delivery, unsubscribe, and a failing listener staying contained.
import { describe, it, expect, vi } from "vitest";
import { listenerCount, publish, subscribe } from "./eventHub";

describe("eventHub", () => {
  it("delivers each event to every listener until it unsubscribes", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = subscribe(a);
    const offB = subscribe(b);
    publish({ type: "workspaces_changed" });
    offA();
    publish({ type: "conversations_changed", workspaceId: "w1" });
    offB();

    expect(a.mock.calls).toEqual([[{ type: "workspaces_changed" }]]);
    expect(b.mock.calls).toEqual([
      [{ type: "workspaces_changed" }],
      [{ type: "conversations_changed", workspaceId: "w1" }],
    ]);
    expect(listenerCount()).toBe(0);
  });

  it("keeps delivering when a listener throws", () => {
    const after = vi.fn();
    const offBad = subscribe(() => {
      throw new Error("boom");
    });
    const offAfter = subscribe(after);
    expect(() => publish({ type: "run_started", workspaceId: "w1", conversationId: "c1" })).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    offBad();
    offAfter();
  });
});
