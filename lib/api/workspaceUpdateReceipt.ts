// The single HTTP receipt for workspace mutations, so UI, CLI and others see the same outcome. Its type is
// shared with lib/client/workspaceReceipt.ts.
import { NextResponse } from "next/server";
import { notFound } from "@/lib/api/guards";
import { getStore } from "@/lib/infra/services";
import type { CredentialKind, CredentialSubject } from "@/lib/infra/security/credentialStore";
import {
  updateWorkspace,
  type UpdateWorkspaceInput,
  type UpdateWorkspaceResult,
  type WorkspaceUpdateValues,
} from "@/lib/operations/workspace/update";

export interface WorkspaceUpdateReceipt {
  ok: true;
  workspaceId: string;
  applied: WorkspaceUpdateValues;
  warning?: string;
}

export function workspaceUpdateReceipt(result: UpdateWorkspaceResult): WorkspaceUpdateReceipt {
  const applied = Object.fromEntries(
    result.applied.map((field) => [field, result.values[field]]),
  ) as WorkspaceUpdateValues;
  return {
    ok: result.ok,
    workspaceId: result.workspaceId,
    applied,
    ...(result.warning ? { warning: result.warning } : {}),
  };
}

/** no-store because a receipt describes one moment of a mutable resource, not a cacheable read. */
export function receiptResponse(result: UpdateWorkspaceResult): NextResponse<WorkspaceUpdateReceipt> {
  return NextResponse.json(workspaceUpdateReceipt(result), { headers: { "Cache-Control": "no-store" } });
}

/** The two channels whose open/closed flag a credential endpoint's PATCH moves. */
export type WorkspaceAccessField = "workspaceApiAccess" | "workspaceMcpAccess";

// Workspace facts on every key receipt (`internetAccess`, which gates neither channel). A workspace
// deleted mid-request adds nothing rather than failing a completed mutation.
export function workspaceReceiptContext(subject: CredentialSubject): Record<string, unknown> {
  if (!subject) return {};
  const workspace = getStore().getWorkspace(subject);
  return workspace ? { internetAccess: workspace.internetAccess } : {};
}

// A credential route's PATCH, via updateWorkspace so it reports exactly like a workspace PATCH. Never
// carries a key; minting is POST's job.
export function channelSetEnabled(field: WorkspaceAccessField) {
  return async (
    _kind: CredentialKind,
    subject: CredentialSubject,
    enabled: boolean,
    request: Request,
  ): Promise<Response> => {
    // Both channels are per-workspace, so a null subject is an instance-wide credential wired to the
    // wrong handler. Refusing here keeps that a 404 rather than an update against an unnamed record.
    if (!subject) return notFound(request, "workspace");
    const input: UpdateWorkspaceInput =
      field === "workspaceApiAccess" ? { workspaceApiAccess: enabled } : { workspaceMcpAccess: enabled };
    const result = await updateWorkspace(subject, input);
    if (!result) return notFound(request, `workspace ${subject}`);
    return receiptResponse(result);
  };
}
