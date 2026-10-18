// Browser half of the workspace update receipt: every optimistic block adopts confirmed values through this one
// function.
import type { WorkspaceUpdateReceipt } from "@/lib/api/workspaceUpdateReceipt";

export type { WorkspaceUpdateReceipt };

// Confirmed values, or {} for a non-receipt. Callers fall back with `?? assumed`, so a missing field
// keeps the optimistic value. Trusted as-is: they come from our typed routes.
export async function confirmedValues(response: Response): Promise<WorkspaceUpdateReceipt["applied"]> {
  try {
    const body = (await response.json()) as Partial<WorkspaceUpdateReceipt> | null;
    return body?.applied ?? {};
  } catch {
    return {};
  }
}
