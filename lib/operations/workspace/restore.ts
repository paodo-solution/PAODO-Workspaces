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

/**
 * Restores an existing workspace to `sha`. A ref that is not a snapshot of THIS workspace is a
 * caller error, not a missing resource: the workspace was found, and the id it supplied for a
 * revision does not name one. Both rejections stay on the invalid-input path so a caller does not
 * have to distinguish "malformed" from "no longer in history" to know it must send a different ref.
 */
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
