import { describe, it, expect } from "vitest";
import { KeyedAsyncLock, getFileLockKey } from "./fileLock";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("KeyedAsyncLock", () => {
  it("serializes operations on the same key in FIFO order", async () => {
    const lock = new KeyedAsyncLock();
    const order: number[] = [];

    const d1 = createDeferred<void>();
    const d2 = createDeferred<void>();

    const p1 = lock.withLock("keyA", async () => {
      order.push(1);
      await d1.promise;
      order.push(2);
      return "res1";
    });

    const p2 = lock.withLock("keyA", async () => {
      order.push(3);
      await d2.promise;
      order.push(4);
      return "res2";
    });

    // Give microtasks time to run: p1 has started, p2 must be waiting
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([1]);

    // Release p1
    d1.resolve();
    const res1 = await p1;
    expect(res1).toBe("res1");

    // Once p1 finishes, p2 starts
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([1, 2, 3]);

    // Release p2
    d2.resolve();
    const res2 = await p2;
    expect(res2).toBe("res2");
    expect(order).toEqual([1, 2, 3, 4]);

    // Map entry cleaned up
    expect(lock.activeKeysCount).toBe(0);
  });

  it("allows operations on different keys to execute concurrently", async () => {
    const lock = new KeyedAsyncLock();
    const order: string[] = [];

    const d1 = createDeferred<void>();
    const d2 = createDeferred<void>();

    const p1 = lock.withLock("keyA", async () => {
      order.push("A:start");
      await d1.promise;
      order.push("A:end");
    });

    const p2 = lock.withLock("keyB", async () => {
      order.push("B:start");
      await d2.promise;
      order.push("B:end");
    });

    // Both start immediately
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toContain("A:start");
    expect(order).toContain("B:start");

    // Complete B before A
    d2.resolve();
    await p2;
    expect(order).toContain("B:end");
    expect(order).not.toContain("A:end");

    // Complete A
    d1.resolve();
    await p1;
    expect(order).toContain("A:end");

    expect(lock.activeKeysCount).toBe(0);
  });

  it("releases the lock and allows downstream tasks to run even if task throws", async () => {
    const lock = new KeyedAsyncLock();
    const downstreamRun = createDeferred<string>();

    const p1 = lock.withLock("keyA", async () => {
      throw new Error("Task failed");
    });

    const p2 = lock.withLock("keyA", async () => {
      downstreamRun.resolve("downstream-ran");
      return "success";
    });

    await expect(p1).rejects.toThrow("Task failed");
    await expect(p2).resolves.toBe("success");
    await expect(downstreamRun.promise).resolves.toBe("downstream-ran");
    expect(lock.activeKeysCount).toBe(0);
  });

  it("does not prematurely delete queue entry when new waiters arrive while active task is completing", async () => {
    const lock = new KeyedAsyncLock();
    const d1 = createDeferred<void>();
    const d2 = createDeferred<void>();

    const p1 = lock.withLock("keyA", async () => {
      await d1.promise;
    });

    // While p1 is running, p2 enqueues
    const p2 = lock.withLock("keyA", async () => {
      await d2.promise;
    });

    expect(lock.activeKeysCount).toBe(1);

    // Release p1
    d1.resolve();
    await p1;

    // Queue still has p2 active, map must not be empty yet
    expect(lock.activeKeysCount).toBe(1);

    // Release p2
    d2.resolve();
    await p2;

    // Queue drained, map must now be clean
    expect(lock.activeKeysCount).toBe(0);
  });

  it("normalizes paths consistently in getFileLockKey", () => {
    const ws = "/data/workspaces/ws1";
    expect(getFileLockKey(ws, "config.env")).toBe(getFileLockKey(ws, "./config.env"));
    expect(getFileLockKey(ws, "config.env")).toBe(getFileLockKey(ws, "/config.env"));
    expect(getFileLockKey(ws, "dir/../config.env")).toBe(getFileLockKey(ws, "config.env"));
    expect(getFileLockKey(ws, "src/index.ts")).not.toBe(getFileLockKey(ws, "config.env"));
    expect(getFileLockKey("/data/workspaces/ws1", "config.env")).not.toBe(
      getFileLockKey("/data/workspaces/ws2", "config.env"),
    );
  });
});
