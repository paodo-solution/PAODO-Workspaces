// The one workspace update path for every trigger (UI, REST, CLI, MCP). Field rules live in their capabilities;
// this validates the whole request first, applies in a fixed order, and reports what landed.
import { getStore } from "@/lib/infra/services";
import type { ReasoningEffort } from "@/lib/models/llmSelection";
import { metadataWrites, validateMetadata, type MetadataWriter, type WorkspaceMetadataInput } from "./metadata";
import { currentModelSelection, publicModelSelection, type WorkspaceLookup } from "./read";
import { setChannelEnabled, validateChannelEnabled, type ChannelCredentials } from "./access";
import { setInternetAccess, validateInternetAccess, type EgressServices, type EgressWriter } from "./egress";
import {
  storeWorkspaceSecret,
  validateSecret,
  type SecretStore,
  type ThirdPartySecret,
  type WorkspaceSecretInput,
} from "./secrets";
import { WorkspaceUpdateFailure } from "./errors";

/**
 * The wire names a workspace PATCH accepts, in one place so the route's emptiness check, its
 * unknown-field rejection and the published contract (lib/operations/contract/fields.ts) cannot drift
 * apart. These are the request's field names, which differ from this operation's input shape: the
 * three llm* fields arrive separately and become one `model`.
 *
 * `secret` is deliberately absent. A third-party secret carries a plaintext value, is scoped to
 * domains, and is listed and deleted through its own endpoints — putting it on the general settings
 * PATCH meant the widest-reaching mutation a programmatic caller has could also plant a credential,
 * and advertising it here invited every such caller to try. The route refuses it explicitly rather
 * than leaving it to the unknown-field branch, which would misdescribe a real field as a typo.
 */
export const WORKSPACE_UPDATABLE_FIELDS = [
  "name",
  "description",
  "maxIterations",
  "maxRunMinutes",
  "internetAccess",
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

/**
 * Everything a caller may change in one request, assembled from the capabilities that own each field.
 * Omitted fields are unchanged, including an omitted description; an explicitly empty description
 * clears it.
 */
export type UpdateWorkspaceInput = WorkspaceMetadataInput & {
  internetAccess?: boolean;
  workspaceApiAccess?: boolean;
  workspaceMcpAccess?: boolean;
  secret?: WorkspaceSecretInput;
};

export interface UpdateWorkspaceResult {
  ok: true;
  workspaceId: string;
  /** Capability fields successfully applied, in deterministic application order. */
  applied: Array<keyof WorkspaceUpdateValues>;
  /**
   * Canonical values established by the write. These come from the shared validators, never from a
   * transport echo, so every adapter reports trimmed, resolved and otherwise normalized values alike.
   * A stored third-party secret is represented only by its safe metadata; its value is never echoed.
   */
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

/**
 * Applies mutable workspace settings through one trigger-neutral entry point. Returns null when the
 * workspace does not exist, so adapters can translate that into their native not-found result.
 *
 * Every supplied value is checked before the first write. That ordering is the contract, not an
 * implementation detail: a request carrying one bad field changes nothing at all, so a caller never has
 * to reason about which half of its request survived.
 *
 * No field here produces a credential. `workspaceApiAccess` and `workspaceMcpAccess` open and close
 * their channels and nothing more; issuing a key is its own explicit operation on the channel's route,
 * so this result never carries a plaintext secret.
 */
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
    const egress = await setInternetAccess(id, internetAccess, existing.internetAccess, store, deps.egress);
    applied(["internetAccess"], egress.applied);
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
      ...field("workspaceApiAccess", apiAccess),
      ...field("workspaceMcpAccess", mcpAccess),
      ...field("secret", secret),
    },
  };
}
