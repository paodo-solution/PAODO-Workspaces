// Shared file-descriptor budget for tree fan-outs: an unbounded Promise.all hits EMFILE and silently drops
// files, e.g. from the download zip.

// Conservative enough to stay under a typical macOS soft limit (ulimit -n 256) while leaving headroom
// for sockets and the rest of the process; still plenty of parallelism to keep the disk busy.
export const MAX_OPEN_FILES = 64;

// Counting semaphore. Releasing hands the permit straight to the next waiter (without touching the
// active count) so the in-flight total never exceeds `max`.
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }
}

// Like Promise.all, but waits for every promise to settle before rethrowing the first failure, so no task
// is still using a directory descriptor that the caller closes on the way out.
export async function settleAll<T>(promises: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(promises);
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

// Walks a directory's subdirectories concurrently while a slot is free, inline otherwise. A walk holds its
// directory open for its whole subtree, so a semaphore here would deadlock; this never waits for a slot.
export class Fanout {
  private active = 0;
  constructor(private readonly max: number) {}

  /** Results in input order. */
  async map<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const runs: Promise<R>[] = [];
    for (const item of items) {
      if (this.active < this.max) {
        this.active++;
        const run = fn(item).finally(() => this.active--);
        run.catch(() => undefined); // handled by settleAll; this only keeps an early failure from being "unhandled"
        runs.push(run);
        continue;
      }
      const inline = fn(item);
      runs.push(inline);
      try {
        await inline;
      } catch {
        break; // settleAll rethrows it once the concurrent walks are done
      }
    }
    return settleAll(runs);
  }
}

/** Concurrent subdirectory walks per traversal; each holds at most one descriptor per level it descends. */
export const MAX_CONCURRENT_WALKS = 8;

/** A semaphore at the shared descriptor budget. One per traversal. */
export function openFileLimiter(): Semaphore {
  return new Semaphore(MAX_OPEN_FILES);
}
