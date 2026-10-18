// Handle ids for the workspace node's two connection points, and the rule for which one an incoming
// link snaps to. Shared: WorkspaceNode renders them, the editor normalizes what a store or drag hands back.

export const WORKSPACE_TOP_HANDLE = "workspace-target-top";
export const WORKSPACE_BOTTOM_HANDLE = "workspace-source-bottom";

const WORKSPACE_INCOMING_HANDLES = new Set<string>([WORKSPACE_TOP_HANDLE, WORKSPACE_BOTTOM_HANDLE]);

// Maps an incoming handle to one the node renders. Old saved ids and loose-mode drags fall back to the
// top handle unless they name a known one.
export function normalizeWorkspaceIncomingHandle(handle?: string | null): string {
  if (handle === "workspace-target-bottom") return WORKSPACE_BOTTOM_HANDLE;
  return handle && WORKSPACE_INCOMING_HANDLES.has(handle) ? handle : WORKSPACE_TOP_HANDLE;
}
