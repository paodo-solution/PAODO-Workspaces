// A shared drive's file tree, for the file panel and `paodo drive file ls`. Query contract:
// lib/api/fileTreeRoutes.ts.
import { NextResponse } from "next/server";
import { requireDrive } from "@/lib/api/guards";
import { driveContentDir } from "@/lib/drives/store";
import { getFileTree } from "@/lib/api/fileTreeRoutes";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const drive = requireDrive(id, req);
  if (drive instanceof NextResponse) return drive;
  return getFileTree(req, { dir: driveContentDir(id), logContext: { driveId: id, route: "drive-files" } });
}
