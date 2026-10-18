// The full model catalog (providers with their models and efforts) in one response, for UI and programmatic
// callers.
import { NextResponse } from "next/server";
import { getModelCatalog } from "@/lib/operations/models/catalog";

export function GET() {
  return NextResponse.json({ providers: getModelCatalog() });
}
