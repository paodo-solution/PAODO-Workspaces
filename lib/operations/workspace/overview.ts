// The complete trigger-neutral workspace read used by the UI and CLI. Capability modules retain
// ownership of their projections; this operation owns assembling them into one public result.
import { getWorkspaceAccess, type WorkspaceAccessDetails } from "./access";
import { listWorkspaceSecrets, type ThirdPartySecret } from "./secrets";
import { listWorkspaceSkills, type ExposedSkill } from "./skills";
import { getWorkspace, type WorkspaceDetails } from "./read";
import { workspaceConnectionCounts, type WorkspaceConnectionCounts } from "../connections/counts";

export type WorkspaceOverview = WorkspaceDetails &
  WorkspaceAccessDetails & {
    exposedSkills: ExposedSkill[];
    thirdPartySecrets: ThirdPartySecret[];
    // Counts only; the connection routes own the details. Present even when all zero, so "none" is
    // explicit.
    connections: WorkspaceConnectionCounts;
  };

export async function getWorkspaceOverview(id: string, connectionOrigin: string): Promise<WorkspaceOverview | null> {
  const workspace = getWorkspace(id);
  if (!workspace) return null;
  return {
    ...workspace,
    ...getWorkspaceAccess(id, connectionOrigin),
    exposedSkills: await listWorkspaceSkills(id),
    thirdPartySecrets: listWorkspaceSecrets(id),
    connections: workspaceConnectionCounts(id),
  };
}
