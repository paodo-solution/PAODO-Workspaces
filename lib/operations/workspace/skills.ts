// Skills declared in .skills/. Read-only: the agent defines the MCP surface by writing skill files.
import { getStore } from "@/lib/infra/services";
import { loadSkills } from "@/lib/skills/store";
import type { WorkspaceReader } from "./read";

/** One skill the workspace declares in .skills/ — an MCP tool while the MCP endpoint is enabled. */
export interface ExposedSkill {
  id: string;
  description: string;
}

/**
 * The declared skills, in the shape the MCP settings UI already shows. Separate from getWorkspace
 * because reading them touches the filesystem; callers that only need metadata should not pay for it.
 */
export async function listWorkspaceSkills(
  id: string,
  store: WorkspaceReader = getStore(),
  loader: (workspaceDir: string) => Promise<ExposedSkill[]> = loadSkills,
): Promise<ExposedSkill[]> {
  const workspace = store.getWorkspace(id);
  if (!workspace) return [];
  return (await loader(workspace.dir)).map((s) => ({ id: s.id, description: s.description }));
}
