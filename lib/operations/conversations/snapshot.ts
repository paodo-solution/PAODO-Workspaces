// The snapshot a workspace's files are at (HEAD), shown in VS Code's header.
import { createLogger } from "@/lib/infra/logger";
import { getStore, getVersioning } from "@/lib/infra/services";

const log = createLogger("conversations");

/** Null when the workspace is gone or versioning cannot say: a missing sha must never fail the request. */
export async function currentSnapshot(workspaceId: string): Promise<string | null> {
  try {
    const ws = getStore().getWorkspace(workspaceId);
    return ws ? await getVersioning().head(ws.id, ws.dir) : null;
  } catch (err) {
    log.warn(
      { event: "workspace_snapshot_unreadable", outcome: "snapshot_omitted", workspaceId, err },
      "could not read the workspace snapshot",
    );
    return null;
  }
}
