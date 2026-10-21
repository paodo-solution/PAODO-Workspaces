// Public workspace projections and trigger-neutral queries.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getStore } from "@/lib/infra/services";
import { defaultModelSelection, modelReasoningEfforts } from "@/lib/agent/buildModel";
import { providerHasKey } from "@/lib/operations/settings/providerKeys";
import { allowlistWarning } from "@/lib/workspace/domain";
import type { DomainAllowlist, Workspace } from "@/lib/workspace/types";
import type { ModelSelection } from "@/lib/models/selection";

export interface WorkspaceSummary {
  id: string;
  name: string;
  description: string;
}

export interface WorkspaceDetails extends WorkspaceSummary {
  createdAt: Date;
  maxIterations: number;
  maxRunMinutes: number;
  internetAccess: boolean;
  /** While true, the container reaches only `allowedDomains`; false when no list was ever saved. */
  domainRestriction: boolean;
  /** Omitted while `domainRestriction` is false, since nothing enforces it then. */
  allowedDomains?: string[];
  /** Present only while the restriction is on with no domain, which blocks every host. */
  warning?: string;
  llmProvider: string;
  llmModel: string;
  /** Whether the selected provider currently has an API key configured. */
  llmProviderHasKey: boolean;
  /** Omitted when the selected provider has no reasoning-effort control. */
  reasoningEffort?: ModelSelection["reasoningEffort"];
}

export type PublicModelSelection = {
  llmProvider: string;
  llmModel: string;
  reasoningEffort?: ModelSelection["reasoningEffort"];
};

export type WorkspaceReader = Pick<IWorkspaceStore, "getWorkspace" | "listWorkspaces">;
export type WorkspaceLookup = Pick<IWorkspaceStore, "getWorkspace">;

// The stored model choice, unexamined, with catalog defaults for unset fields. Withdrawn providers are
// cleared at startup, so none reach here.
export function currentModelSelection(workspace: Workspace): ModelSelection {
  const fallback = defaultModelSelection();
  return {
    provider: workspace.llmProvider ?? fallback.provider,
    model: workspace.llmModel ?? fallback.model,
    reasoningEffort: workspace.reasoningEffort ?? fallback.reasoningEffort,
  };
}

/** Project the complete internal model tuple onto the public workspace representation. */
export function publicModelSelection(selection: ModelSelection): PublicModelSelection {
  const supportsReasoningEffort = modelReasoningEfforts(selection.provider, selection.model).length > 0;
  return {
    llmProvider: selection.provider,
    llmModel: selection.model,
    ...(supportsReasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
  };
}

/** The allowlist as the workspace read shows it: its domains only while they are enforced. */
function publicDomainAllowlist(
  allowlist: DomainAllowlist | undefined,
): Pick<WorkspaceDetails, "domainRestriction" | "allowedDomains" | "warning"> {
  const warning = allowlistWarning(allowlist);
  return allowlist?.restricted
    ? { domainRestriction: true, allowedDomains: [...allowlist.domains], ...(warning ? { warning } : {}) }
    : { domainRestriction: false };
}

export function workspaceSummary(workspace: Workspace): WorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    description: workspace.description ?? "",
  };
}

export function listWorkspaces(store: WorkspaceReader = getStore()): WorkspaceSummary[] {
  return store.listWorkspaces().map(workspaceSummary);
}

export function getWorkspace(
  id: string,
  store: WorkspaceLookup = getStore(),
  hasProviderKey: (provider: string) => boolean = providerHasKey,
): WorkspaceDetails | null {
  const workspace = store.getWorkspace(id);
  if (!workspace) return null;
  const modelSelection = currentModelSelection(workspace);
  return {
    ...workspaceSummary(workspace),
    createdAt: workspace.createdAt,
    maxIterations: workspace.maxIterations,
    maxRunMinutes: workspace.maxRunMinutes,
    internetAccess: workspace.internetAccess,
    ...publicDomainAllowlist(workspace.domainAllowlist),
    ...publicModelSelection(modelSelection),
    llmProviderHasKey: hasProviderKey(modelSelection.provider),
  };
}
