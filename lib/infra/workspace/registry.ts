// Registry of all workspaces: the injectable `WorkspaceStore` class, plus the production singleton
// `defaultWorkspaceStore`. Conversation history lives in lib/conversations/store.ts.
import path from "path";
import { createLogger, createAuditLogger } from "../logger";
import { atomicSaveJson, readJson } from "../jsonPersist";
import { scaffoldWorkspaceDir } from "./scaffold";
import { validateWorkspaceName, normalizeForUniqueness, WorkspaceNameError } from "../../workspace/name";
import { isDomainAllowlist } from "../../workspace/domain";
import { defaultWorkspaceVersioning } from "../git";
import { WORKSPACES_ROOT, workspaceRegistryFile } from "../paths";
import type { IWorkspaceStore } from "../interfaces";
import type { ReasoningEffort } from "../../models/llmSelection";
import { setInternetAccessPolicy } from "../proxy/internetAccessPolicy";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_MAX_RUN_MINUTES, normalizeMaxRunMinutes } from "../../workspace/limits";
import type { DomainAllowlist, Workspace } from "../../workspace/types";
import { assertWorkspaceRegistryRecords } from "../startupChecks";
export type { Workspace } from "../../workspace/types";

const log = createLogger("store");
const audit = createAuditLogger("store");

interface WorkspaceRecord {
  id: string;
  name: string;
  dir?: string;
  createdAt: string;
  maxIterations?: number;
  maxRunMinutes?: number;
  description?: string;
  llmProvider?: string;
  llmModel?: string;
  reasoningEffort?: ReasoningEffort;
  internetAccess?: boolean;
  domainAllowlist?: DomainAllowlist;
}

const REGISTRY_FILE = workspaceRegistryFile();

type PersistFn = (records: WorkspaceRecord[]) => void;
type LoadFn = () => WorkspaceRecord[] | null;

export interface WorkspaceStoreOptions {
  /** Backing map. Defaults to a fresh Map. The production singleton injects the global map. */
  map?: Map<string, Workspace>;
  /** Persist the registry. Defaults to a no-op (tests). The production singleton writes JSON. */
  persist?: PersistFn;
  /** Load initial records at construction. Defaults to none (tests). */
  load?: LoadFn;
  // Start the workspace's versioning repo on creation. Defaults to a no-op (tests). Injected to avoid
  // an import cycle with the services layer.
  initRepo?: (workspaceId: string, workspaceDir: string) => Promise<void>;
  /** Create a new workspace's directory. Defaults to {@link scaffoldWorkspaceDir}; tests stub it. */
  scaffold?: (dir: string) => Promise<void>;
}

export class WorkspaceStore implements IWorkspaceStore {
  private workspaces: Map<string, Workspace>;
  private persistFn: PersistFn;
  private initRepoFn: (workspaceId: string, workspaceDir: string) => Promise<void>;
  private scaffoldFn: (dir: string) => Promise<void>;
  // Serializes create and rename so two concurrent requests can't both pass the name-uniqueness check.
  private mutationChain: Promise<unknown> = Promise.resolve();

  constructor(opts: WorkspaceStoreOptions = {}) {
    this.workspaces = opts.map ?? new Map();
    this.persistFn = opts.persist ?? (() => {});
    this.initRepoFn = opts.initRepo ?? (async () => {});
    this.scaffoldFn = opts.scaffold ?? scaffoldWorkspaceDir;
    // A hot-reloaded server can reuse workspace objects created by an older module version. Fill
    // the new field in-place so those live objects do not accidentally create a zero-delay timer.
    for (const workspace of this.workspaces.values()) {
      workspace.maxRunMinutes = normalizeMaxRunMinutes(workspace.maxRunMinutes);
    }
    const records = (opts.load ?? (() => null))();
    if (records) this.hydrate(records);
  }

  // Directories are keyed by id, so a malformed name can't affect a path. Every record is kept, since
  // dropping one would hide a workspace whose data is still on disk.
  private hydrate(records: WorkspaceRecord[]): void {
    for (const r of records) {
      const dir = path.join(WORKSPACES_ROOT, r.id);
      const allowlistReadable = this.checkDomainAllowlist(r);
      this.workspaces.set(r.id, {
        id: r.id,
        name: r.name,
        dir,
        createdAt: new Date(r.createdAt),
        maxIterations: r.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        maxRunMinutes: normalizeMaxRunMinutes(r.maxRunMinutes),
        description: r.description,
        llmProvider: r.llmProvider,
        llmModel: r.llmModel,
        reasoningEffort: r.reasoningEffort,
        internetAccess: allowlistReadable ? (r.internetAccess ?? true) : false,
        domainAllowlist: allowlistReadable ? r.domainAllowlist : undefined,
      });
    }
  }

  // Fails closed for this workspace only: an unreadable allowlist turns its internet access off until the
  // owner resets it, while every other workspace keeps working. Dropping the list would leave it open.
  private checkDomainAllowlist(r: WorkspaceRecord): boolean {
    if (r.domainAllowlist === undefined || isDomainAllowlist(r.domainAllowlist)) return true;
    log.error(
      { event: "workspace_domain_allowlist_malformed", outcome: "internet_access_disabled", workspaceId: r.id },
      "workspace domain allowlist is malformed — turning its internet access off",
    );
    return false;
  }

  private save(): void {
    const records: WorkspaceRecord[] = Array.from(this.workspaces.values()).map((w) => ({
      id: w.id,
      name: w.name,
      createdAt: w.createdAt.toISOString(),
      maxIterations: w.maxIterations,
      maxRunMinutes: w.maxRunMinutes,
      description: w.description,
      llmProvider: w.llmProvider,
      llmModel: w.llmModel,
      reasoningEffort: w.reasoningEffort,
      internetAccess: w.internetAccess,
      domainAllowlist: w.domainAllowlist,
    }));
    this.persistFn(records);
  }

  // The live object is already updated, so a failed write is logged with its operation: otherwise the next
  // restart silently restores the previous value.
  private saveUpdate(workspaceId: string, operation: string): void {
    try {
      this.save();
    } catch (err) {
      log.error(
        {
          event: "workspace_registry_save_failed",
          outcome: "workspace_update_in_memory_only",
          err,
          workspaceId,
          operation,
          filePath: REGISTRY_FILE,
        },
        "failed to save workspace registry update",
      );
      throw err;
    }
  }

  // The stored tail swallows errors so one failed mutation can't block later ones; the caller still gets
  // fn's real result or rejection.
  private serializeMutation<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.mutationChain.then(fn, fn);
    this.mutationChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  // Compares folded keys, so case- and Unicode-equivalent names can't coexist while agents route by name.
  // Callers must hold the mutation lock.
  private assertNameAvailable(name: string, exceptId?: string): void {
    const key = normalizeForUniqueness(name);
    for (const ws of this.workspaces.values()) {
      if (ws.id !== exceptId && normalizeForUniqueness(ws.name) === key) {
        throw new WorkspaceNameError("WORKSPACE_NAME_CONFLICT", `A workspace named "${name}" already exists.`);
      }
    }
  }

  async createWorkspace(rawName: string): Promise<Workspace> {
    return this.serializeMutation(async () => {
      const name = validateWorkspaceName(rawName);
      this.assertNameAvailable(name);
      const id = crypto.randomUUID();
      log.info({ name }, "creating workspace");
      const dir = path.join(WORKSPACES_ROOT, id);
      await this.scaffoldFn(dir);

      // Start the versioning repo over the scaffolded files. Best-effort: a missing git binary (or
      // any git failure) must not block workspace creation — versioning is strictly additive.
      try {
        await this.initRepoFn(id, dir);
      } catch (err) {
        log.warn({ err, id, name }, "versioning initRepo failed; workspace created without it");
      }

      const workspace: Workspace = {
        id,
        name,
        dir,
        createdAt: new Date(),
        maxIterations: DEFAULT_MAX_ITERATIONS,
        maxRunMinutes: DEFAULT_MAX_RUN_MINUTES,
        internetAccess: false,
      };

      this.workspaces.set(id, workspace);
      try {
        this.save();
      } catch (err) {
        // POST /api/workspaces logs the create failure; rethrow without logging it twice.
        throw err;
      }
      // The proxy's policy store defaults unknown ids to enabled, so record the off default right away.
      setInternetAccessPolicy(id, false);
      return workspace;
    });
  }

  getWorkspace(id: string): Workspace | undefined {
    return this.workspaces.get(id);
  }

  getWorkspaceByName(name: string): Workspace | undefined {
    const all = [...this.workspaces.values()];
    // Exact match first: it disambiguates duplicates loaded from before uniqueness was enforced.
    const exact = all.find((w) => w.name === name);
    if (exact) return exact;
    // Then the folded key, matching the uniqueness rule: call_agent("sales") finds "Sales".
    const key = normalizeForUniqueness(name);
    return all.find((w) => normalizeForUniqueness(w.name) === key);
  }

  listWorkspaces(): Workspace[] {
    return Array.from(this.workspaces.values());
  }

  async renameWorkspace(id: string, rawName: string): Promise<boolean> {
    return this.serializeMutation(async () => {
      const ws = this.workspaces.get(id);
      if (!ws) return false;
      const name = validateWorkspaceName(rawName);
      this.assertNameAvailable(name, id);
      // Metadata only: directories, conversations, versioning and secrets are all keyed by id.
      ws.name = name;
      this.saveUpdate(id, "rename_workspace");
      return true;
    });
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    this.workspaces.delete(id);
    try {
      this.save();
    } catch (err) {
      // Put it back so memory and disk agree; one that vanished and reappeared on restart would be worse.
      // The delete stays retryable.
      this.workspaces.set(id, ws);
      log.error(
        {
          event: "workspace_registry_delete_persist_failed",
          outcome: "workspace_restored_pending_retry",
          err,
          workspaceId: id,
          filePath: REGISTRY_FILE,
        },
        "failed to save registry after workspace deletion",
      );
      throw err;
    }
    return true;
  }

  setWorkspaceMaxIterations(id: string, n: number): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.maxIterations = n;
    this.saveUpdate(id, "set_max_iterations");
    return true;
  }

  setWorkspaceMaxRunMinutes(id: string, minutes: number): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.maxRunMinutes = minutes;
    this.saveUpdate(id, "set_max_run_minutes");
    return true;
  }

  setWorkspaceDescription(id: string, description: string): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.description = description.trim();
    this.saveUpdate(id, "set_description");
    return true;
  }

  setWorkspaceLlm(id: string, sel: { provider: string; model: string; reasoningEffort: ReasoningEffort }): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.llmProvider = sel.provider;
    ws.llmModel = sel.model;
    ws.reasoningEffort = sel.reasoningEffort;
    this.saveUpdate(id, "set_llm");
    return true;
  }

  setWorkspaceInternetAccess(id: string, enabled: boolean): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.internetAccess = enabled;
    this.saveUpdate(id, "set_internet_access");
    audit.info({ wsId: id, enabled, event: "workspace_internet_access_toggled" }, "internet access toggled");
    return true;
  }

  setWorkspaceDomainAllowlist(id: string, allowlist: DomainAllowlist): boolean {
    const ws = this.workspaces.get(id);
    if (!ws) return false;
    ws.domainAllowlist = { restricted: allowlist.restricted, domains: [...allowlist.domains] };
    this.saveUpdate(id, "set_domain_allowlist");
    audit.info(
      { wsId: id, ...ws.domainAllowlist, event: "workspace_domain_allowlist_changed" },
      "domain allowlist changed",
    );
    return true;
  }

  // Resets workspaces whose provider is not in `allowed` to "never picked", so they fall back to an offered
  // provider instead of failing on send. The audit line records what was cleared.
  clearWithdrawnLlmSelections(allowed: readonly string[]): Array<{ workspaceId: string; provider: string }> {
    const offered = new Set(allowed);
    const stranded = this.listWorkspaces().filter((ws) => ws.llmProvider && !offered.has(ws.llmProvider));
    if (stranded.length === 0) return [];
    const cleared = stranded.map((ws) => ({ workspaceId: ws.id, provider: ws.llmProvider as string }));
    for (const ws of stranded) {
      ws.llmProvider = undefined;
      ws.llmModel = undefined;
      ws.reasoningEffort = undefined;
    }
    try {
      this.save();
    } catch (err) {
      // Memory is cleared but disk is not; startup refuses to serve on this, so the mismatch dies with the
      // process.
      log.error(
        {
          event: "workspace_registry_save_failed",
          outcome: "withdrawn_llm_selections_cleared_in_memory_only",
          err,
          operation: "clear_withdrawn_llm_selections",
          workspaceIds: cleared.map((entry) => entry.workspaceId),
          filePath: REGISTRY_FILE,
        },
        "failed to save workspace registry after clearing withdrawn model selections",
      );
      throw err;
    }
    for (const { workspaceId, provider } of cleared) {
      audit.warn(
        {
          event: "workspace_llm_selection_cleared",
          outcome: "model_selection_reset_to_default",
          workspaceId,
          provider,
        },
        "provider withdrawn by configuration — the workspace's model selection was cleared",
      );
    }
    return cleared;
  }
}

// Production singleton, on `global` so server.ts and the Next-bundled routes share one Map (as wsHub.ts).
const g = global as typeof global & { _workspaces?: Map<string, Workspace> };
const freshMap = !g._workspaces;
if (!g._workspaces) g._workspaces = new Map();

function defaultLoad(): WorkspaceRecord[] | null {
  // Only read the registry when this module instance owns a fresh map; otherwise an earlier
  // instance already populated it and re-reading would duplicate/overwrite live workspace state.
  if (!freshMap) return null;
  const records = readJson<unknown>(REGISTRY_FILE, null);
  if (records === null) {
    log.debug("workspace registry not found — starting fresh");
    return null;
  }
  // Startup refuses to boot on a malformed registry, on every run. This loader stays defensive only
  // because it runs at import time — before server.ts installs the fatal handlers that report it.
  try {
    assertWorkspaceRegistryRecords(records);
    return records as unknown as WorkspaceRecord[];
  } catch {
    return null;
  }
}

export const defaultWorkspaceStore = new WorkspaceStore({
  map: g._workspaces,
  persist: (records) => atomicSaveJson(REGISTRY_FILE, records),
  load: defaultLoad,
  initRepo: (id, dir) => defaultWorkspaceVersioning.initRepo(id, dir),
});
