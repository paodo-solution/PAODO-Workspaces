// Live background tasks for the TopBar indicator: rescans and prunes exited tasks without killing any, trimmed
// to what the UI shows.
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/api/guards";
import { getContainers } from "@/lib/infra/services";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ws = requireWorkspace(id, req);
  if (ws instanceof NextResponse) return ws;

  const tasks = (await getContainers().listBackgroundLive(id)).map((t) => ({
    taskId: t.taskId,
    command: t.command,
    startedAt: t.startedAt,
  }));
  return NextResponse.json({ count: tasks.length, tasks });
}
