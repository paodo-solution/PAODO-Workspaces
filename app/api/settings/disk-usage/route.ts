// Disk usage of WORKSPACES_ROOT's mount for the settings bar; available:false when the path is missing
// (outside the container).
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { getDiskUsage } from "@/lib/infra/storage/diskSpace";
import { WORKSPACES_ROOT } from "@/lib/infra/paths";

export async function GET() {
  try {
    const usage = await getDiskUsage(WORKSPACES_ROOT);
    return NextResponse.json({ available: true, ...usage }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ available: false }, { headers: { "Cache-Control": "no-store" } });
  }
}
