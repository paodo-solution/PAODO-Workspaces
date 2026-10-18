// File content CRUD for a workspace (GET, PUT, PATCH move, DELETE) over the shared file modules, plus a git
// snapshot and a PUT-only container fallback for old root-owned files.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getContainers, getVersioning } from "@/lib/infra/services";
import { requireWorkspace } from "@/lib/api/guards";
import { snapshotWorkspace } from "@/lib/infra/git/snapshotWorkspace";
import { getFileContent, putFileContent, deleteFileContent } from "@/lib/api/fileContentRoutes";
import { moveFileContent } from "@/lib/files/move";
import type { FileBackend } from "@/lib/files/backend";
import type { Workspace } from "@/lib/workspace/types";

function backend(ws: Workspace): FileBackend {
  return {
    dir: ws.dir,
    logContext: { workspaceId: ws.id, route: "files/content" },
    // Old root-owned files are overwritten through the container; r+ without create, so a concurrent move can't
    // recreate the old path. relPath is already the container's path space.
    writeFallback: async (relPath, content) => {
      const overwriteExisting = [
        "const fs=require('fs');",
        "const fd=fs.openSync(process.argv[1],'r+');",
        "try{fs.ftruncateSync(fd,0);fs.writeFileSync(fd,fs.readFileSync(0));}",
        "finally{fs.closeSync(fd);}",
      ].join("");
      const r = await getContainers().exec(ws.id, ws.dir, ["node", "-e", overwriteExisting, `/workspace/${relPath}`], {
        stdin: content,
      });
      if (r.code !== 0) throw new Error(r.stderr || "docker write failed");
    },
    afterWrite: async (message) => {
      await snapshotWorkspace(getVersioning(), ws, message);
    },
  };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return getFileContent(req, backend(ws));
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return putFileContent(req, backend(ws));
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return moveFileContent(req, backend(ws));
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id);
  if (ws instanceof NextResponse) return ws;
  return deleteFileContent(req, backend(ws));
}
