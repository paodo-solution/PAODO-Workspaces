// Rolls a workspace back to a snapshot. Irreversible (no copy is kept), so it sits beside delete.ts rather
// than in update.ts. Files are bind-mounted, so the running agent sees the result at once.
import type { IWorkspaceVersionRestorer } from "@/lib/infra/interfaces";
import { getVersioning } from "@/lib/infra/services";
import { isSnapshotSha } from "@/lib/infra/git/sha";
import { WorkspaceUpdateError } from "./errors";

export interface RestoreWorkspaceInput {
  sha?: unknown;
}

export interface RestoreWorkspaceResult {
  restored: true;
  /** The snapshot the work-tree now sits at, echoed so a caller can confirm what it landed on. */
  sha: string;
}

/** Only the id and the work-tree path; the versioning service keys the git dir off the id. */
export interface RestoreTarget {
  id: string;
  dir: string;
}

// A malformed sha and one that isn't this workspace's snapshot are both invalid input, not not-found:
// either way the caller must send a different ref.
export async function restoreWorkspace(
  workspace: RestoreTarget,
  input: RestoreWorkspaceInput,
  versioning: IWorkspaceVersionRestorer = getVersioning(),
): Promise<RestoreWorkspaceResult> {
  if (!isSnapshotSha(input.sha)) {
    throw new WorkspaceUpdateError("invalid sha", { field: "sha" });
  }
  const sha = input.sha;

  if (!(await versioning.restore(workspace.id, workspace.dir, sha))) {
    throw new WorkspaceUpdateError("unknown sha", { field: "sha" });
  }
  return { restored: true, sha };
}
