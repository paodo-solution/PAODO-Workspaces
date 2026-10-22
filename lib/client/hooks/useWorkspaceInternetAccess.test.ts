// Each edit sends the whole list as shown, one at a time and in order, so a refused list edit is carried by the
// next one. fetch is mocked to control when each save answers.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyChange,
  createSerialQueue,
  sendAccessChange,
  settleEdit,
  shownAccess,
  type AccessEdits,
} from "./useWorkspaceInternetAccess";

const confirmed = { enabled: true, domainRestriction: true, allowedDomains: ["a.com", "b.com", "c.com"] };
const edits = (pending: AccessEdits["pending"]): AccessEdits => ({ id: "ws", source: null, confirmed, pending });

const receipt = (applied: Record<string, unknown>) => new Response(JSON.stringify({ applied }), { status: 200 });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("applyChange", () => {
  it("replaces the list with the one sent", () => {
    expect(applyChange(confirmed, { allowedDomains: ["d.com"] }).allowedDomains).toEqual(["d.com"]);
  });

  it("leaves the list alone for a flag-only change", () => {
    expect(applyChange(confirmed, { domainRestriction: false })).toEqual({ ...confirmed, domainRestriction: false });
  });
});

describe("shownAccess", () => {
  it("applies every unanswered edit over the confirmed state, in order", () => {
    const shown = shownAccess(
      edits([
        { seq: 1, change: { allowedDomains: ["b.com", "c.com"] } },
        { seq: 2, change: { allowedDomains: ["c.com"] } },
      ]),
    );
    expect(shown.allowedDomains).toEqual(["c.com"]);
  });
});

describe("settleEdit", () => {
  it("drops a refused edit without undoing the edits made after it", () => {
    const state = edits([
      { seq: 1, change: { domainRestriction: false } },
      { seq: 2, change: { allowedDomains: ["c.com"] } },
    ]);
    const shown = shownAccess(settleEdit(state, 1, null));
    expect(shown.domainRestriction).toBe(true);
    expect(shown.allowedDomains).toEqual(["c.com"]);
  });

  it("keeps a refused list edit on screen when a later list edit already carries it", () => {
    const state = edits([
      { seq: 1, change: { allowedDomains: ["b.com", "c.com"] } },
      { seq: 2, change: { allowedDomains: ["c.com"] } },
    ]);
    expect(shownAccess(settleEdit(state, 1, null)).allowedDomains).toEqual(["c.com"]);
  });

  it("takes the saved list the server reports", () => {
    const state = edits([{ seq: 1, change: { allowedDomains: ["API.d.com"] } }]);
    const settled = settleEdit(state, 1, { allowedDomains: ["api.d.com"] });
    expect(settled.pending).toEqual([]);
    expect(settled.confirmed.allowedDomains).toEqual(["api.d.com"]);
  });

  it("applies the change itself when the receipt leaves a field out", () => {
    const settled = settleEdit(edits([{ seq: 1, change: { domainRestriction: false } }]), 1, {});
    expect(settled.confirmed.domainRestriction).toBe(false);
  });
});

describe("createSerialQueue", () => {
  it("starts each task only after the previous one settles, failed or not", async () => {
    const enqueue = createSerialQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = enqueue(
      () =>
        new Promise<void>((_, reject) => {
          releaseFirst = () => {
            order.push("first done");
            reject(new Error("refused"));
          };
        }),
    );
    const second = enqueue(async () => {
      order.push("second started");
    });
    await Promise.resolve();
    expect(order).toEqual([]);
    releaseFirst();
    await expect(first).rejects.toThrow("refused");
    await second;
    expect(order).toEqual(["first done", "second started"]);
  });

  it("sends two quick list saves in the order they were made, even if the first answers slowly", async () => {
    const bodies: string[] = [];
    const answers: Array<() => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        bodies.push(init.body as string);
        return new Promise<Response>((resolve) => answers.push(() => resolve(receipt({}))));
      }),
    );
    const enqueue = createSerialQueue();
    const first = enqueue(() => sendAccessChange("ws", { allowedDomains: ["b.com"] }));
    const second = enqueue(() => sendAccessChange("ws", { allowedDomains: [] }));
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    answers[0]();
    await first;
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    answers[1]();
    await second;
    expect(bodies.map((b) => JSON.parse(b))).toEqual([{ allowedDomains: ["b.com"] }, { allowedDomains: [] }]);
  });
});

describe("sendAccessChange", () => {
  it("returns only what the receipt reports, as the hook's field names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => receipt({ allowedDomains: ["api.x.com"], internetAccess: true })),
    );
    expect(await sendAccessChange("ws", { allowedDomains: ["https://API.x.com/"] })).toEqual({
      allowedDomains: ["api.x.com"],
      enabled: true,
    });
  });

  it("returns null for a refused change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 400 })),
    );
    expect(await sendAccessChange("ws", { domainRestriction: true })).toBeNull();
  });

  it("returns null when the server can't be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    expect(await sendAccessChange("ws", { domainRestriction: true })).toBeNull();
  });
});
