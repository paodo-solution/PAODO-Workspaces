// CLI tar transport for a drive (shared core: lib/api/fileTransferRoutes.ts). No versioning: drives have no
// git history, so a push is final, like `drive rm`.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { rateLimited, requireDrive } from "@/lib/api/guards";
import { driveContentDir } from "@/lib/drives/store";
import { getFileTransfer, putFileTransfer } from "@/lib/api/fileTransferRoutes";

function backend(id: string) {
  return { dir: driveContentDir(id), logContext: { driveId: id, route: "drive-files/transfer" } };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id, req);
  if (drive instanceof NextResponse) return drive;
  return getFileTransfer(req, backend(id));
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Budgeted like a workspace push: a drive write lands in every connected agent's view.
  const limited = rateLimited(req, { policy: "upload", scope: id, logContext: { driveId: id } });
  if (limited) return limited;

  const drive = requireDrive(id, req);
  if (drive instanceof NextResponse) return drive;
  return putFileTransfer(req, backend(id));
}
