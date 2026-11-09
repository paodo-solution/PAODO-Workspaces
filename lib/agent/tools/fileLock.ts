// In-memory keyed async lock for serializing mutations to the same workspace file.
// Operations on the same (workspace, path) key run serially in FIFO order.
// Operations on different keys run concurrently.

import path from "path";

export class KeyedAsyncLock {
  private queues = new Map<string, Promise<unknown>>();

  /**
   * Executes `fn` within an exclusive lock for `key`.
   * Waits for any previously queued operation on `key` to finish before starting `fn`.
   * Unblocks downstream waiters and cleans up the queue entry when done.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const current = this.queues.get(key) ?? Promise.resolve();

    let releaseTicket!: () => void;
    const ticket = new Promise<void>((resolve) => {
      releaseTicket = resolve;
    });

    // Chain onto the tail for this key.
    // Handles rejections so a failed task does not block downstream waiters.
    const chain = current.then(
      () => ticket,
      () => ticket,
    );
    this.queues.set(key, chain);

    // Wait for the prior task on this key to release.
    await current.catch(() => {});

    try {
      return await fn();
    } finally {
      releaseTicket();
      // Only delete if no newer task has enqueued behind this one.
      if (this.queues.get(key) === chain) {
        this.queues.delete(key);
      }
    }
  }

  /** Reports the number of currently tracked lock keys (used for test assertions and leak verification). */
  get activeKeysCount(): number {
    return this.queues.size;
  }
}

/**
 * Produces a normalized lock key combining the workspace directory and the normalized relative file path.
 */
export function getFileLockKey(workspaceDir: string, relpath: string): string {
  const ws = path.resolve(workspaceDir);
  const file = path.posix.normalize(relpath).replace(/^\/+/, "");
  return `${ws}:${file}`;
}

/**
 * Process-wide singleton lock instance shared across agent tools.
 */
export const workspaceFileLocks = new KeyedAsyncLock();
