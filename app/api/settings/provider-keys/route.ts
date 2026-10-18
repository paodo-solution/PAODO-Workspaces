// Lists provider key status (writes are on [provider]). Kept out of platformAccessPolicy.ts: the CLI may know
// `hasKey` (via /api/models) but not the hint, a partial disclosure.
export const runtime = "nodejs";

import { type NextRequest, NextResponse } from "next/server";
import { appErrorResponse, errorResponse } from "@/lib/api/errorResponse";
import { createLogger } from "@/lib/infra/logger";
import { listProviderKeys } from "@/lib/operations/settings/providerKeys";

const log = createLogger("api").child({ route: "provider-keys" });
// no-store like every other credential-adjacent response: no key material appears here, but which
// providers this deployment can spend through is not something to leave in an intermediary.
const NO_STORE = { "Cache-Control": "no-store" } as const;

export function GET(req: NextRequest) {
  try {
    return NextResponse.json({ providers: listProviderKeys() }, { headers: NO_STORE });
  } catch (err) {
    const expected = appErrorResponse(err, req);
    if (expected) return expected;
    log.error(
      { event: "provider_keys_read_failed", outcome: "status_not_returned", code: "INTERNAL_ERROR", err },
      "failed to read provider key status",
    );
    return errorResponse("INTERNAL_ERROR", "failed to read provider key status", { request: req });
  }
}
