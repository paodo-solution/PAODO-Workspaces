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

/** A semaphore at the shared descriptor budget. One per traversal. */
export function openFileLimiter(): Semaphore {
  return new Semaphore(MAX_OPEN_FILES);
}
