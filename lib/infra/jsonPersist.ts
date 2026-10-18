// Atomic JSON persistence: write to a .tmp file then rename to avoid partial writes on crash.
import { mkdirSync, writeFileSync, renameSync, readFileSync } from "fs";
import path from "path";
import { createLogger } from "./logger";

const log = createLogger("persistence");

export function atomicSaveJson(filePath: string, data: unknown): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, filePath);
}

// Reads JSON or returns `fallback` if missing or corrupt; stores needing to tell those apart read their own.
export function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    // A missing file is the normal first-run case. Corruption, permissions, and I/O failures are
    // not: keep the existing fallback behavior, but never make persisted state disappear silently.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error(
        { event: "persisted_json_load_failed", outcome: "fallback_used", err, filePath },
        "failed to load persisted JSON — using fallback",
      );
    }
    return fallback;
  }
}
