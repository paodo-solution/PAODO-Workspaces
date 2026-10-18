// The upload size limit, enforced by upload.ts and pre-checked by useFileUpload.ts, so the UI never accepts
// what the server 413s. Client-bundled: no server-only imports.

// Per-file cap on every byte path. Uploads stream to disk, so it can exceed RAM. The browser sends one
// request per file; the CLI's single-request transfer also gets the caps below.
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024; // 1 GB

// Bounds inodes, which byte checks miss (millions of empty files). Well above a real tree (Linux is
// ~80k files), so it stops abuse, not work.
export const MAX_TRANSFER_ENTRIES = 100_000;

// Bounds the time and I/O one request can hold a connection for (30-minute timeout), separate from the
// per-entry free-space check.
export const MAX_TRANSFER_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB

/** Byte size for limit messages — "1 GB", "734.2 MB", "512 B". */
export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole and large values read cleanly as integers ("1 GB", "734 MB"); keep one decimal for the
  // small fractional cases where rounding to "0 MB" would be useless.
  const rounded = Number.isInteger(value) || value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
