// Server-only free-space check, split out from uploadLimits.ts (which stays client-bundleable and
// therefore free of fs imports) so it can be unit-tested in isolation.
import fs from "fs/promises";

// Headroom every write path keeps, since nothing caps total uploads and a full disk takes down every
// workspace. Matches MAX_UPLOAD_BYTES so the two read as one policy.
export const RESERVED_FREE_BYTES = 1024 * 1024 * 1024; // 1 GB

export interface FreeSpaceCheck {
  ok: boolean;
  freeBytes: number;
}

/** Whether `dir`'s filesystem fits `neededBytes` plus `reservedBytes`; `dir` must already exist. */
export async function checkFreeSpace(dir: string, neededBytes: number, reservedBytes: number): Promise<FreeSpaceCheck> {
  const stats = await fs.statfs(dir);
  const freeBytes = stats.bavail * stats.bsize;
  return { ok: freeBytes >= neededBytes + reservedBytes, freeBytes };
}

export interface DiskUsage {
  total: number;
  used: number;
  free: number;
}

// For the settings storage bar. Excludes root-reserved blocks, so the bar shows only space an
// unprivileged writer can actually fill.
export async function getDiskUsage(dir: string): Promise<DiskUsage> {
  const stats = await fs.statfs(dir);
  const used = (stats.blocks - stats.bfree) * stats.bsize;
  const free = stats.bavail * stats.bsize;
  return { total: used + free, used, free };
}

// For write tools that report failure as an "Error: ..." string. The upload route and execute_command
// need their own response shape and call checkFreeSpace directly.
export async function requireFreeSpace(dir: string, neededBytes: number): Promise<string | null> {
  const space = await checkFreeSpace(dir, neededBytes, RESERVED_FREE_BYTES);
  return space.ok ? null : "Error: not enough free disk space to write this file.";
}
