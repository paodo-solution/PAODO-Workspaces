// CLI tar transport for a workspace (shared core: lib/api/fileTransferRoutes.ts). Adds the git snapshot that
// makes a push undoable; pushes spend the browser upload's budget, pulls don't.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { rateLimited, requireWorkspace } from "@/lib/api/guards";
import { changed, getFileTransfer, putFileTransfer } from "@/lib/api/fileTransferRoutes";
import { getVersioning } from "@/lib/infra/services";
import { createLogger } from "@/lib/infra/logger";
import { flushSnapshotBurstStrict, snapshotWorkspaceStrict } from "@/lib/infra/git/snapshotWorkspace";
import type { PutTransferReceipt } from "@/lib/operations/files/transfer";

const log = createLogger("api");

function backend(id: string, dir: string) {
  return { dir, logContext: { workspaceId: id, route: "workspace-files/transfer" } };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  return getFileTransfer(req, backend(id, ws.dir));
}

// Commits so the transfer can be undone, returning only success. No sha: it snapshots the whole
// workspace and would be misread as naming the pushed paths.
async function snapshot(id: string, ws: { id: string; dir: string }, receipt: PutTransferReceipt): Promise<boolean> {
  try {
    await snapshotWorkspaceStrict(
      getVersioning(),
      ws,
      changed(receipt) === 1 ? "put 1 workspace entry" : `put ${changed(receipt)} workspace entries`,
    );
    return true;
  } catch (err) {
    log.error(
      { event: "file_transfer_snapshot_failed", outcome: "transfer_applied_without_snapshot", workspaceId: id, err },
      "failed to snapshot imported workspace transfer",
    );
    return false;
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Same bucket as browser uploads, for parity. A whole push is one token; MAX_TRANSFER_ENTRIES/_BYTES are
  // the real bound.
  const limited = rateLimited(req, { policy: "upload", scope: id, logContext: { workspaceId: id } });
  if (limited) return limited;

  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;
  return putFileTransfer(req, backend(id, ws.dir), {
    beforeApply: async () => {
      await flushSnapshotBurstStrict(getVersioning(), ws);
    },
    commit: (receipt) => snapshot(id, ws, receipt),
  });
}
