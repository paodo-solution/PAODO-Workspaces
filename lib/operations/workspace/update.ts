// The one workspace update path for every trigger (UI, REST, CLI, MCP). Field rules live in their capabilities;
// this validates the whole request first, applies in a fixed order, and reports what landed.
import { getStore } from "@/lib/infra/services";
import type { ReasoningEffort } from "@/lib/models/llmSelection";
import { metadataWrites, validateMetadata, type MetadataWriter, type WorkspaceMetadataInput } from "./metadata";
import { currentModelSelection, publicModelSelection, type WorkspaceLookup } from "./read";
import { setChannelEnabled, validateChannelEnabled, type ChannelCredentials } from "./access";
import {
  resolveDomainAllowlist,
  setDomainAllowlist,
  setInternetAccess,
  validateAllowedDomains,
  validateDomainListEdit,
  validateDomainRestriction,
  validateInternetAccess,
  type EgressServices,
  type EgressWriter,
} from "./egress";
import {
  storeWorkspaceSecret,
  validateSecret,
  type SecretStore,
  type ThirdPartySecret,
  type WorkspaceSecretInput,
} from "./secrets";
import { WorkspaceUpdateFailure } from "./errors";

// The PATCH wire fields, shared by the route and the published contract so they can't drift. `secret`
// is absent on purpose: secrets have their own endpoints.
export const WORKSPACE_UPDATABLE_FIELDS = [
  "name",
  "description",
  "maxIterations",
  "maxRunMinutes",
  "internetAccess",
  "domainRestriction",
  "allowedDomains",
  "addAllowedDomains",
  "removeAllowedDomains",
  "workspaceApiAccess",
  "workspaceMcpAccess",
  "llmProvider",
  "llmModel",
  "reasoningEffort",
] as const;

/** Runs `validate` only when `value` was supplied — the update contract's "omitted means unchanged" rule. */
function ifDefined<T, R>(value: T | undefined, validate: (value: T) => R): R | undefined {
  return value === undefined ? undefined : validate(value);
}

/** One result field, present only when `value` was set — so a typo'd key fails to compile instead of silently vanishing. */
function field<K extends keyof WorkspaceUpdateValues>(
  key: K,
  value: WorkspaceUpdateValues[K] | undefined,
): Pick<WorkspaceUpdateValues, K> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Pick<WorkspaceUpdateValues, K>);
}

/** Omitted fields stay unchanged; an explicitly empty description clears it. */
export type UpdateWorkspaceInput = WorkspaceMetadataInput & {
  internetAccess?: boolean;
  domainRestriction?: boolean;
  /** Replaces the whole list; can't be combined with add/remove. */
  allowedDomains?: string[];
  /** Appended unless already listed. */
  addAllowedDomains?: string[];
  /** Dropped if listed; an unlisted one is a no-op. */
  removeAllowedDomains?: string[];
  workspaceApiAccess?: boolean;
  workspaceMcpAccess?: boolean;
  secret?: WorkspaceSecretInput;
};

export interface UpdateWorkspaceResult {
  ok: true;
  workspaceId: string;
  /** Capability fields successfully applied, in deterministic application order. */
  applied: Array<keyof WorkspaceUpdateValues>;
  // Normalized values from the shared validators, not a transport echo. A secret appears only as
  // metadata, never its value.
  values: WorkspaceUpdateValues;
}

export type WorkspaceUpdateValues = {
  name?: string;
  description?: string;
  maxIterations?: number;
  maxRunMinutes?: number;
  llmProvider?: string;
  llmModel?: string;
  reasoningEffort?: ReasoningEffort;
  internetAccess?: boolean;
  domainRestriction?: boolean;
  /** The whole list as saved, reported whenever a request changed it (replace, add or remove). */
  allowedDomains?: string[];
  addAllowedDomains?: string[];
  removeAllowedDomains?: string[];
  workspaceApiAccess?: boolean;
  workspaceMcpAccess?: boolean;
  secret?: ThirdPartySecret;
};

/** The store surface an update needs: the record's own setters, plus egress, plus the lookup. */
export type UpdateWorkspaceStore = WorkspaceLookup & MetadataWriter & EgressWriter;

/** Per-capability seams, each defaulting to the real system. Tests override only what they assert on. */
export interface UpdateWorkspaceDeps {
  store?: UpdateWorkspaceStore;
  credentials?: ChannelCredentials;
  egress?: EgressServices;
  secrets?: SecretStore;
}

// Null if the workspace is missing. Validates everything before the first write, so one bad field
// changes nothing; never mints a credential, so it never returns a secret.
export async function updateWorkspace(
  id: string,
  input: UpdateWorkspaceInput,
  deps: UpdateWorkspaceDeps = {},
): Promise<UpdateWorkspaceResult | null> {
  const store = deps.store ?? getStore();
  const existing = store.getWorkspace(id);
  if (!existing) return null;

  // Phase one: validate everything, touch nothing.
  const metadata = validateMetadata(input, currentModelSelection(existing));
  const internetAccess = ifDefined(input.internetAccess, validateInternetAccess);
  const domainRestriction = ifDefined(input.domainRestriction, validateDomainRestriction);
  const allowedDomains = ifDefined(input.allowedDomains, (value) => validateAllowedDomains(value));
  const addDomains = ifDefined(input.addAllowedDomains, (value) => validateAllowedDomains(value, "addAllowedDomains"));
  const removeDomains = ifDefined(input.removeAllowedDomains, (value) =>
    validateAllowedDomains(value, "removeAllowedDomains"),
  );
  const allowlistChanges = {
    restricted: domainRestriction,
    domains: allowedDomains,
    add: addDomains,
    remove: removeDomains,
  };
  const changesAllowlist = Object.values(allowlistChanges).some((value) => value !== undefined);
  const changesDomains = allowedDomains !== undefined || addDomains !== undefined || removeDomains !== undefined;
  validateDomainListEdit(allowlistChanges);
  // Catches an over-full list before any write; it is resolved again at write time against the latest list.
  if (changesAllowlist) resolveDomainAllowlist(existing.domainAllowlist, allowlistChanges);
  const apiAccess = ifDefined(input.workspaceApiAccess, (value) => validateChannelEnabled("workspaceApiAccess", value));
  const mcpAccess = ifDefined(input.workspaceMcpAccess, (value) => validateChannelEnabled("workspaceMcpAccess", value));
  const secretInput = ifDefined(input.secret, validateSecret);

  // Setters refuse only for an unknown id, so a refusal now means the workspace was deleted mid-update.
  // Report what was applied, so a half-done update isn't read as a no-op.
  const appliedFields: Array<keyof WorkspaceUpdateValues> = [];
  // Takes all field names one write settles (`model` sets three), so a refusal names every one.
  const applied = (fields: Array<keyof WorkspaceUpdateValues>, ok: boolean): void => {
    if (!ok) {
      throw new WorkspaceUpdateFailure(
        `workspace was deleted while updating; applied: ${appliedFields.join(", ") || "nothing"}; not applied: ${fields.join(", ")}`,
      );
    }
    appliedFields.push(...fields);
  };

  // Resolved once and reused for the receipt below, so the projection cannot drift between what the
  // update claims it applied and the values it reports.
  const modelValues = metadata.model === undefined ? undefined : publicModelSelection(metadata.model);
  const modelFields = Object.keys(modelValues ?? {}) as Array<keyof WorkspaceUpdateValues>;

  for (const { field, write } of metadataWrites(id, metadata, store)) {
    applied(field === "model" ? modelFields : [field], await write());
  }

  if (internetAccess !== undefined) {
    const egress = await setInternetAccess(
      id,
      internetAccess,
      existing.internetAccess,
      existing.domainAllowlist,
      store,
      deps.egress,
    );
    applied(["internetAccess"], egress.applied);
  }

  // One write for every allowlist field. Read and written with no await between, so a concurrent request's
  // change to the list is merged with this one instead of overwritten by a list read before it landed.
  let savedDomains: string[] | undefined;
  if (changesAllowlist) {
    const latest = store.getWorkspace(id);
    const fields: Array<keyof WorkspaceUpdateValues> = [
      ...(domainRestriction !== undefined ? (["domainRestriction"] as const) : []),
      ...(addDomains !== undefined ? (["addAllowedDomains"] as const) : []),
      ...(removeDomains !== undefined ? (["removeAllowedDomains"] as const) : []),
      ...(changesDomains ? (["allowedDomains"] as const) : []),
    ];
    if (!latest) applied(fields, false);
    const { previous, next } = resolveDomainAllowlist(latest?.domainAllowlist, allowlistChanges);
    const allowlist = setDomainAllowlist(
      id,
      next,
      previous,
      internetAccess ?? latest?.internetAccess ?? false,
      store,
      deps.egress,
    );
    applied(fields, allowlist.applied);
    if (changesDomains) savedDomains = next.domains;
  }

  // These three write through capabilities that raise rather than return a flag, so reaching the next
  // line is itself the success signal — hence `true` rather than a result to check.
  if (apiAccess !== undefined) {
    setChannelEnabled("workspace-api", id, apiAccess, deps.credentials);
    applied(["workspaceApiAccess"], true);
  }
  if (mcpAccess !== undefined) {
    setChannelEnabled("workspace-mcp", id, mcpAccess, deps.credentials);
    applied(["workspaceMcpAccess"], true);
  }

  let secret: ThirdPartySecret | undefined;
  if (secretInput !== undefined) {
    secret = storeWorkspaceSecret(id, secretInput, store, deps.secrets);
    applied(["secret"], true);
  }

  return {
    ok: true,
    workspaceId: id,
    applied: appliedFields,
    values: {
      ...field("name", metadata.name),
      ...field("description", metadata.description),
      ...field("maxIterations", metadata.maxIterations),
      ...field("maxRunMinutes", metadata.maxRunMinutes),
      ...(modelValues ?? {}),
      ...field("internetAccess", internetAccess),
      ...field("domainRestriction", domainRestriction),
      ...field("addAllowedDomains", addDomains),
      ...field("removeAllowedDomains", removeDomains),
      ...field("allowedDomains", savedDomains),
      ...field("workspaceApiAccess", apiAccess),
      ...field("workspaceMcpAccess", mcpAccess),
      ...field("secret", secret),
    },
  };
}
