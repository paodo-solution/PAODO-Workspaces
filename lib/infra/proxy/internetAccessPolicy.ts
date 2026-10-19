// Per-workspace internet policy the proxy checks before any tunnel: off (backing up the detached sidecar)
// or restricted to exact hosts. On disk because the sidecar is a separate process: the app writes, the sidecar only reloads.
import path from "path";
import { readFileSync } from "fs";
import { WORKSPACES_ROOT } from "../paths";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { globalSingleton } from "../globalSingleton";
import { createLogger } from "../logger";
import type { DomainAllowlist } from "../../workspace/types";
import { enforcedDomains } from "../../workspace/domain";

const log = createLogger("internetAccessPolicy");
// Lives inside .proxy-ca/ so the sidecar can mount that one directory rather than the whole
// workspaces volume, which also holds the conversation database and every workspace's files.
const FILE = path.join(WORKSPACES_ROOT, ".proxy-ca", "internet-access.json");
export const INTERNET_ACCESS_POLICY_FILE = FILE;

// wsId -> false (internet off) or the hosts it may reach (restricted). Sparse: an absent key means open,
// matching WorkspaceMetadata.internetAccess's default.
type Entry = false | string[];
type Store = Record<string, Entry>;

// Fixed reference, shared across every module instance via globalSingleton — mutated in place
// everywhere below (never reassigned) so all instances keep seeing the same state.
const store: Store = globalSingleton<Store>("internetAccessPolicy", () => readJson<Store>(FILE, {}));

// Off wins over the allowlist; a list that enforces nothing (not restricted, or empty) writes nothing.
// Re-enabling internet access therefore brings back exactly the restriction the workspace had.
function entryFor(enabled: boolean, allowlist?: DomainAllowlist): Entry | undefined {
  if (!enabled) return false;
  const domains = enforcedDomains(allowlist);
  return domains ? [...domains] : undefined;
}

export function setInternetAccessPolicy(wsId: string, enabled: boolean, allowlist?: DomainAllowlist): void {
  const entry = entryFor(enabled, allowlist);
  if (entry === undefined) delete store[wsId];
  else store[wsId] = entry;
  try {
    atomicSaveJson(FILE, store);
  } catch (err) {
    log.error(
      { event: "internet_access_policy_save_failed", outcome: "policy_change_not_persisted", err, wsId },
      "failed to persist internet-access policy",
    );
    throw err;
  }
}

export function isInternetAccessEnabled(wsId: string): boolean {
  return store[wsId] !== false;
}

/** The exact hosts a restricted workspace may reach, or null when it isn't restricted. */
export function allowedDomainsFor(wsId: string): readonly string[] | null {
  const entry = store[wsId];
  return Array.isArray(entry) ? entry : null;
}

export function deleteInternetAccessPolicy(wsId: string): void {
  if (!(wsId in store)) return;
  delete store[wsId];
  atomicSaveJson(FILE, store);
}

/** A workspace as the registry records it. The registry is the primary record; this file mirrors it. */
export interface InternetAccessRecord {
  id: string;
  internetAccess?: boolean;
  domainAllowlist?: DomainAllowlist;
}

const sameEntry = (a: Entry | undefined, b: Entry | undefined) => JSON.stringify(a) === JSON.stringify(b);

// Rebuilds the mirror from the registry at startup: a missing entry reads as open, so a stale mirror
// fails open. Throws if the file can't be written and read back, which startup treats as fatal.
export function reconcileInternetAccessPolicy(workspaces: InternetAccessRecord[]): void {
  const expected = new Map<string, Entry>();
  for (const w of workspaces) {
    const entry = entryFor(w.internetAccess !== false, w.domainAllowlist);
    if (entry !== undefined) expected.set(w.id, entry);
  }
  const restored = [...expected].filter(([id, entry]) => !sameEntry(store[id], entry)).map(([id]) => id);
  const dropped = Object.keys(store).filter((id) => !expected.has(id));

  for (const id of dropped) delete store[id];
  for (const [id, entry] of expected) store[id] = entry;
  atomicSaveJson(FILE, store);

  // Read back rather than trust the write: this file is the sidecar's only view of the boundary,
  // and it is the app's last chance to notice the volume is not holding what it was handed.
  const persisted = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  const persistedIds = Object.keys(persisted);
  if (
    persistedIds.length !== expected.size ||
    persistedIds.some((id) => !expected.has(id) || !sameEntry(persisted[id], expected.get(id)))
  ) {
    throw new Error("internet-access policy did not persist as written");
  }

  if (restored.length > 0 || dropped.length > 0) {
    log.warn(
      { event: "internet_access_policy_reconciled", outcome: "policy_rebuilt_from_registry", restored, dropped },
      "internet-access mirror disagreed with the workspace registry — rebuilt from the registry",
    );
    return;
  }
  log.info(
    {
      event: "internet_access_policy_verified",
      outcome: "policy_matches_registry",
      disabled: [...expected.values()].filter((e) => e === false).length,
      restricted: [...expected.values()].filter(Array.isArray).length,
    },
    "internet-access mirror matches the workspace registry",
  );
}

// Sidecar-only: re-read the on-disk policy into memory, replacing it in place for the same
// globalSingleton-sharing reason as above. Only a successful read replaces the served state.
export function reloadInternetAccessPolicy(): void {
  let next: Store;
  try {
    next = JSON.parse(readFileSync(FILE, "utf-8")) as Store;
  } catch (err) {
    // ENOENT included: the app writes this file on every boot and the sidecar waits for it, so a
    // vanished or corrupt file is an anomaly — resetting to empty would re-enable every workspace.
    log.error(
      { event: "internet_access_policy_reload_failed", outcome: "policy_unchanged", err, filePath: FILE },
      "failed to reload internet-access policy — keeping last-known-good state",
    );
    return;
  }
  for (const k of Object.keys(store)) delete store[k];
  Object.assign(store, next);
}
