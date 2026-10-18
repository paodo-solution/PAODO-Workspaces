// Creates host-only key files with 0600 in one place, so no caller can miss the chmod. Callers own read and
// regeneration policy.
import { mkdirSync, writeFileSync, chmodSync } from "fs";
import path from "path";
import { randomBytes } from "crypto";

export function createKeyFile(filePath: string, bytes = 32): Buffer {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const key = randomBytes(bytes);
  writeFileSync(filePath, key, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  return key;
}
