// Reads one directory through the shared fd budget and ignore contract, so every traversal agrees on its
// contents. readdir errors propagate: each caller decides how to handle an unreadable directory.
import fs from "fs/promises";
import type { Dirent } from "fs";
import { ignoreRuleFor, type IgnoreContract, IGNORE_CONTRACT } from "./ignore";
import type { Semaphore } from "./fdLimit";

// The entries of `dirPath` that a transfer is allowed to see, in readdir order. Throws whatever readdir throws.
export async function readTransferEntries(
  dirPath: string,
  sem: Semaphore,
  contract: IgnoreContract = IGNORE_CONTRACT,
): Promise<Dirent[]> {
  const entries = await sem.run(() => fs.readdir(dirPath, { withFileTypes: true }));
  return entries.filter((entry) => ignoreRuleFor(entry.name, entry.isDirectory(), contract) === undefined);
}

/** What one bounded read saw, and whether it stopped early. */
export interface ListingEntries {
  entries: Dirent[];
  /** The scan hit `maxEntries` before the end of the directory, so `entries` is a prefix of it. */
  truncated: boolean;
}

// Listing-only (a capped transfer would pass a prefix off as the whole tree). opendir streams so the
// cap bounds the scan itself; it counts post-ignore entries and holds one fd throughout.
export async function readListingEntries(
  dirPath: string,
  sem: Semaphore,
  maxEntries: number,
  contract: IgnoreContract = IGNORE_CONTRACT,
): Promise<ListingEntries> {
  return sem.run(async () => {
    const entries: Dirent[] = [];
    let truncated = false;
    const dir = await fs.opendir(dirPath);
    // `for await` closes the handle itself — on a `break` and on a throw, not only on completion — so
    // an explicit close here would just hit ERR_DIR_CLOSED.
    for await (const entry of dir) {
      if (ignoreRuleFor(entry.name, entry.isDirectory(), contract) !== undefined) continue;
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
    return { entries, truncated };
  });
}
