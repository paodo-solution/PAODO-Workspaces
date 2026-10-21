// The one workspace update path for every trigger (UI, REST, CLI, MCP). Field rules live in their capabilities;
// this validates the whole request first, applies in a fixed order, and reports what landed.
import { getStore } from "@/lib/infra/services";
import type { ReasoningEffort } from "@/lib/models/llmSelection";
import { metadataWrites, validateMetadata, type MetadataWriter, type WorkspaceMetadataInput } from "./metadata";
import { currentModelSelection, publicModelSelection, type WorkspaceLookup } from "./read";
import { setChannelEnabled, validateChannelEnabled, type ChannelCredentials } from "./access";
import {
  setDomainAllowlist,
  setInternetAccess,
  validateAllowedDomains,
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
import { allowlistWarning } from "@/lib/workspace/domain";

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
  /** Replaces the whole list; an empty one clears it. */
  allowedDomains?: string[];
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
  /** Set when an allowlist change leaves the restriction on with no domain, which blocks every host. */
  warning?: string;
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
  /** The whole list as saved, normalized and deduplicated. */
  allowedDomains?: string[];
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
  const allowedDomains = ifDefined(input.allowedDomains, validateAllowedDomains);
  const changesAllowlist = domainRestriction !== undefined || allowedDomains !== undefined;
  const apiAccess = ifDefined(input.workspaceApiAccess, (value) => validateChannelEnabled("workspaceApiAccess", value));
  const mcpAccess = ifDefined(input.workspaceMcpAccess, (value) => validateChannelEnabled("workspaceMcpAccess", value));
  const secretInput = ifDefined(input.secret, validateSecret);

  // Setters refuse only for an unknown id, so a refusal now means the workspace was deleted mid-update.
  // Report what was applied, so a half-done update isn't read as a no-op.
  const appliedFields: Array<keyof WorkspaceUpdateValues> = [];
  // Takes all field names one write settles (`model` sets three), so a refusal names every one.
  function notApplied(fields: Array<keyof WorkspaceUpdateValues>): never {
    throw new WorkspaceUpdateFailure(
      `workspace was deleted while updating; applied: ${appliedFields.join(", ") || "nothing"}; not applied: ${fields.join(", ")}`,
    );
  }
  const applied = (fields: Array<keyof WorkspaceUpdateValues>, ok: boolean): void => {
    if (!ok) notApplied(fields);
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

  // One write for both allowlist fields; the latest record is read so a field left out keeps its saved value.
  let warning: string | undefined;
  if (changesAllowlist) {
    const latest = store.getWorkspace(id);
    const fields: Array<keyof WorkspaceUpdateValues> = [
      ...(domainRestriction !== undefined ? (["domainRestriction"] as const) : []),
      ...(allowedDomains !== undefined ? (["allowedDomains"] as const) : []),
    ];
    if (!latest) notApplied(fields);
    const previous = latest.domainAllowlist ?? { restricted: false, domains: [] };
    const next = { restricted: domainRestriction ?? previous.restricted, domains: allowedDomains ?? previous.domains };
    const allowlist = setDomainAllowlist(
      id,
      next,
      previous,
      internetAccess ?? latest.internetAccess,
      store,
      deps.egress,
    );
    applied(fields, allowlist.applied);
    warning = allowlistWarning(next);
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
      ...field("allowedDomains", allowedDomains),
      ...field("workspaceApiAccess", apiAccess),
      ...field("workspaceMcpAccess", mcpAccess),
      ...field("secret", secret),
    },
    ...(warning ? { warning } : {}),
  };
}
