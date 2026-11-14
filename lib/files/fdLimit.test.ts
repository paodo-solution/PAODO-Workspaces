// Fanout: sibling walks run concurrently up to a cap, results keep input order, and a failure is only
// reported once every walk already started has settled.

import { describe, expect, it } from "vitest";
import { Fanout, settleAll } from "./fdLimit";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("Fanout.map", () => {
  it("returns results in input order however they finish", async () => {
    const results = await new Fanout(4).map([30, 5, 20, 0], async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });
    expect(results).toEqual([30, 5, 20, 0]);
  });

  it("never runs more concurrent walks than the cap, nested walks included", async () => {
    const fanout = new Fanout(3);
    let running = 0;
    let peak = 0;
    const walk = async (depth: number): Promise<number> => {
      running++;
      peak = Math.max(peak, running);
      await tick();
      const below = depth < 3 ? await fanout.map([1, 2, 3, 4], () => walk(depth + 1)) : [];
      running--;
      return 1 + below.reduce((sum, n) => sum + n, 0);
    };
    expect(await walk(0)).toBe(1 + 4 + 16 + 64);
    // Each concurrent walk is one chain, plus the inline chain of the caller: at most cap + 1 per level.
    expect(peak).toBeLessThanOrEqual((3 + 1) * 4);
  });

  it("waits for every started walk before rethrowing a failure", async () => {
    let settled = 0;
    const run = new Fanout(2).map([0, 1, 2], async (i) => {
      await tick();
      settled++;
      if (i === 0) throw new Error("boom");
      return i;
    });
    await expect(run).rejects.toThrow("boom");
    expect(settled).toBe(3);
  });

  it("stops starting inline walks after one fails", async () => {
    const started: number[] = [];
    const run = new Fanout(0).map([0, 1, 2], async (i) => {
      started.push(i);
      if (i === 1) throw new Error("boom");
      return i;
    });
    await expect(run).rejects.toThrow("boom");
    expect(started).toEqual([0, 1]);
  });
});

describe("settleAll", () => {
  it("rethrows the first failure only after the others settle", async () => {
    let slowDone = false;
    const slow = tick().then(() => {
      slowDone = true;
    });
    await expect(settleAll([Promise.reject(new Error("first")), slow])).rejects.toThrow("first");
    expect(slowDone).toBe(true);
  });
});
