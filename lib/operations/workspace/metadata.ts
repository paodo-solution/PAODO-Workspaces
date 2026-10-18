// Validation, canonicalization, and persistence descriptors for workspace metadata updates.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { type ReasoningEffort } from "@/lib/models/llmSelection";
import {
  availableProviders,
  defaultModelSelection,
  modelReasoningEfforts,
  providerAvailabilityEnv,
  SUPPORTED_PROVIDERS,
  vocabularyFor,
} from "@/lib/agent/buildModel";
import { resolveModelSelection, type ModelSelection, type RequestedModelSelection } from "@/lib/models/selection";
import { validateWorkspaceName } from "@/lib/workspace/name";
import {
  MAX_WORKSPACE_DESCRIPTION_LENGTH,
  MAX_MAX_ITERATIONS,
  MAX_MAX_RUN_MINUTES,
  MIN_MAX_ITERATIONS,
  MIN_MAX_RUN_MINUTES,
} from "@/lib/workspace/limits";
import { WorkspaceUpdateError } from "./errors";

/** The metadata fields of the update contract, as a caller supplies them — unvalidated. */
export interface WorkspaceMetadataInput {
  name?: string;
  description?: string;
  maxIterations?: number;
  maxRunMinutes?: number;
  // Any subset of the model fields; the rest resolve like the picker, so a provider alone is enough.
  model?: RequestedModelSelection;
}

/** The same fields once checked and canonicalized: safe to hand to the store as-is. */
export interface WorkspaceMetadata {
  name?: string;
  description?: string;
  maxIterations?: number;
  maxRunMinutes?: number;
  model?: ModelSelection;
}

export type MetadataWriter = Pick<
  IWorkspaceStore,
  | "renameWorkspace"
  | "setWorkspaceDescription"
  | "setWorkspaceMaxIterations"
  | "setWorkspaceMaxRunMinutes"
  | "setWorkspaceLlm"
>;

// Pure, so a whole request is checked before any write. Out-of-range numbers are refused, not clamped;
// `current` (default: a fresh workspace's) resolves a partial model.
export function validateMetadata(
  input: WorkspaceMetadataInput,
  current: ModelSelection = defaultModelSelection(),
): WorkspaceMetadata {
  const metadata: WorkspaceMetadata = {};

  if (input.name !== undefined) metadata.name = validateWorkspaceName(input.name);
  if (input.description !== undefined) {
    if (typeof input.description !== "string") {
      throw new WorkspaceUpdateError("description must be a string", { field: "description" });
    }
    const description = input.description.trim();
    if (description.length > MAX_WORKSPACE_DESCRIPTION_LENGTH) {
      throw new WorkspaceUpdateError(`description cannot exceed ${MAX_WORKSPACE_DESCRIPTION_LENGTH} characters`);
    }
    metadata.description = description;
  }

  if (input.maxIterations !== undefined) {
    const value = input.maxIterations;
    if (!Number.isInteger(value) || value < MIN_MAX_ITERATIONS || value > MAX_MAX_ITERATIONS) {
      throw new WorkspaceUpdateError(
        `maxIterations must be an integer between ${MIN_MAX_ITERATIONS} and ${MAX_MAX_ITERATIONS}`,
      );
    }
    metadata.maxIterations = value;
  }

  if (input.maxRunMinutes !== undefined) {
    const value = input.maxRunMinutes;
    if (!Number.isInteger(value) || value < MIN_MAX_RUN_MINUTES || value > MAX_MAX_RUN_MINUTES) {
      throw new WorkspaceUpdateError(
        `maxRunMinutes must be an integer between ${MIN_MAX_RUN_MINUTES} and ${MAX_MAX_RUN_MINUTES}`,
      );
    }
    metadata.maxRunMinutes = value;
  }

  if (input.model !== undefined) {
    // A present but blank or non-string field is a caller error, not an omission; checked before resolution so
    // the error names the accepted values, not a default.
    const unusable = (value: unknown): boolean => value !== undefined && (typeof value !== "string" || !value.trim());
    if (unusable(input.model.provider)) {
      throw new WorkspaceUpdateError(`llmProvider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`);
    }
    if (unusable(input.model.model)) throw new WorkspaceUpdateError("llmModel required");
    // Type only: a blank effort still means "provider default". Its legality needs the provider, checked below.
    if (input.model.reasoningEffort !== undefined && typeof input.model.reasoningEffort !== "string") {
      throw new WorkspaceUpdateError("reasoningEffort must be a string", { field: "reasoningEffort" });
    }

    // Fill the gaps, then check what came out. Resolution is shared with the picker so a partial choice
    // means the same thing here as it does in the UI; see lib/models/selection.ts.
    const selection = resolveModelSelection(input.model, current, vocabularyFor);

    // Effort levels differ per provider, so the error carries the accepted values.
    if (!SUPPORTED_PROVIDERS.includes(selection.provider)) {
      throw new WorkspaceUpdateError(`llmProvider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`);
    }

    // Supported isn't offered: a switched-off provider has no key, so storing it would fail on the next message.
    // Own message, so it doesn't hide the setting the caller wrote.
    const offered = availableProviders();
    if (!offered.includes(selection.provider)) {
      throw new WorkspaceUpdateError(
        `${selection.provider} is not offered in this deployment ` +
          `(set ${providerAvailabilityEnv(selection.provider)}=true in .env to offer it). ` +
          (offered.length
            ? `Pick one of: ${offered.join(", ")}.`
            : "No provider is switched on, so no workspace can be given one."),
        { field: "llmProvider", provider: selection.provider },
      );
    }
    // Only reachable for a supported provider serving no models that the workspace was not already on —
    // resolution supplies a model in every other case.
    if (!selection.model) throw new WorkspaceUpdateError("llmModel required");

    // The model must belong to the provider; the picker can't express a mismatch, so API callers get the same check.
    const models = vocabularyFor(selection.provider).models;
    if (!models.includes(selection.model)) {
      throw new WorkspaceUpdateError(`llmModel for ${selection.provider} must be one of: ${models.join(", ")}`);
    }

    // A named effort the model rejects is refused, not replaced. Checked per model: Scaleway's gateway
    // accepts any level, so this is the only check.
    const efforts = modelReasoningEfforts(selection.provider, selection.model);
    const named = input.model.reasoningEffort?.trim();
    // Guards a model with no dial at all, which would otherwise be told to pick "one of: ".
    if (named && efforts.length === 0) {
      throw new WorkspaceUpdateError(`reasoningEffort is not supported for ${selection.model}`, {
        field: "reasoningEffort",
        provider: selection.provider,
      });
    }
    if (named && !efforts.includes(named as ReasoningEffort)) {
      throw new WorkspaceUpdateError(`reasoningEffort for ${selection.model} must be one of: ${efforts.join(", ")}`);
    }

    metadata.model = selection;
  }

  return metadata;
}

// One write per supplied field, in a fixed order. Returned rather than run, so the caller decides how
// to record and report each one.
export function metadataWrites(
  id: string,
  metadata: WorkspaceMetadata,
  store: MetadataWriter,
): Array<{ field: keyof WorkspaceMetadata; write: () => boolean | Promise<boolean> }> {
  const writes: Array<{ field: keyof WorkspaceMetadata; write: () => boolean | Promise<boolean> }> = [];
  const { name, description, maxIterations, maxRunMinutes, model } = metadata;

  if (name !== undefined) writes.push({ field: "name", write: () => store.renameWorkspace(id, name) });
  if (description !== undefined) {
    writes.push({ field: "description", write: () => store.setWorkspaceDescription(id, description) });
  }
  if (maxIterations !== undefined) {
    writes.push({ field: "maxIterations", write: () => store.setWorkspaceMaxIterations(id, maxIterations) });
  }
  if (maxRunMinutes !== undefined) {
    writes.push({ field: "maxRunMinutes", write: () => store.setWorkspaceMaxRunMinutes(id, maxRunMinutes) });
  }
  if (model !== undefined) writes.push({ field: "model", write: () => store.setWorkspaceLlm(id, model) });

  return writes;
}
