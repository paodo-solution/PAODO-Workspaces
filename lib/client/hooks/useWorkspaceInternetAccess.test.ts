// Allowlist edits go as add/remove, one at a time and in order, and a refused one undoes only itself. fetch is
// mocked to control when each save answers.

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
  it("drops removals and appends additions not already listed, like the server", () => {
    const next = applyChange(confirmed, { removeAllowedDomains: ["a.com"], addAllowedDomains: ["b.com", "d.com"] });
    expect(next.allowedDomains).toEqual(["b.com", "c.com", "d.com"]);
  });

  it("leaves the list alone for a flag-only change", () => {
    expect(applyChange(confirmed, { domainRestriction: false })).toEqual({ ...confirmed, domainRestriction: false });
  });
});

describe("shownAccess", () => {
  it("applies every unanswered edit over the confirmed state, in order", () => {
    const shown = shownAccess(
      edits([
        { seq: 1, change: { removeAllowedDomains: ["a.com"] } },
        { seq: 2, change: { removeAllowedDomains: ["b.com"] } },
      ]),
    );
    expect(shown.allowedDomains).toEqual(["c.com"]);
  });
});

describe("settleEdit", () => {
  it("drops a refused edit without undoing the edits made after it", () => {
    const state = edits([
      { seq: 1, change: { removeAllowedDomains: ["a.com"] } },
      { seq: 2, change: { removeAllowedDomains: ["b.com"] } },
    ]);
    expect(shownAccess(settleEdit(state, 1, null)).allowedDomains).toEqual(["a.com", "c.com"]);
  });

  it("takes the saved list the server reports, including another client's additions", () => {
    const state = edits([{ seq: 1, change: { removeAllowedDomains: ["a.com"] } }]);
    const settled = settleEdit(state, 1, { allowedDomains: ["b.com", "c.com", "from-cli.com"] });
    expect(settled.pending).toEqual([]);
    expect(settled.confirmed.allowedDomains).toEqual(["b.com", "c.com", "from-cli.com"]);
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

  it("sends two quick removals in the order they were made, even if the first answers slowly", async () => {
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
    const first = enqueue(() => sendAccessChange("ws", { removeAllowedDomains: ["a.com"] }));
    const second = enqueue(() => sendAccessChange("ws", { removeAllowedDomains: ["b.com"] }));
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    answers[0]();
    await first;
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    answers[1]();
    await second;
    expect(bodies.map((b) => JSON.parse(b))).toEqual([
      { removeAllowedDomains: ["a.com"] },
      { removeAllowedDomains: ["b.com"] },
    ]);
  });
});

describe("sendAccessChange", () => {
  it("returns only what the receipt reports, as the hook's field names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        receipt({ addAllowedDomains: ["api.x.com"], allowedDomains: ["api.x.com"], internetAccess: true }),
      ),
    );
    expect(await sendAccessChange("ws", { addAllowedDomains: ["https://API.x.com/"] })).toEqual({
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
