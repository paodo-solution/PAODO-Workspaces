// Workspace-name policy, separate from the registry so it's testable: validateWorkspaceName checks display
// names; normalizeForUniqueness folds case and Unicode while agents route by name.
import path from "path";
import { WORKSPACES_ROOT } from "../infra/paths";
import { AppError } from "../errors/appError";

export const MAX_WORKSPACE_NAME_LENGTH = 100;

export type WorkspaceNameErrorCode = "WORKSPACE_NAME_INVALID" | "WORKSPACE_NAME_CONFLICT";

/** Thrown for both malformed names (INVALID) and collisions (CONFLICT); routes map code → status. */
export class WorkspaceNameError extends AppError {
  constructor(
    readonly code: WorkspaceNameErrorCode,
    message: string,
  ) {
    super(code, message);
    this.name = "WorkspaceNameError";
  }
}

// Control chars (C0 range + DEL) that must never appear in a filesystem-facing or displayed name.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

// Validates and cleans a user-supplied workspace name. Returns the canonical display form
// (trimmed, NFC-normalized). Throws WorkspaceNameError("WORKSPACE_NAME_INVALID") on any violation.
export function validateWorkspaceName(raw: string): string {
  // A JSON body may send a non-string; refuse it with the typed error (400) instead of a TypeError (500).
  if (typeof raw !== "string") {
    throw new WorkspaceNameError("WORKSPACE_NAME_INVALID", "Workspace name must be a string.");
  }
  const name = raw.trim().normalize("NFC");

  if (!name) {
    throw new WorkspaceNameError("WORKSPACE_NAME_INVALID", "Workspace name cannot be empty.");
  }
  if (name.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new WorkspaceNameError(
      "WORKSPACE_NAME_INVALID",
      `Workspace name cannot exceed ${MAX_WORKSPACE_NAME_LENGTH} characters.`,
    );
  }
  if (CONTROL_CHARS.test(name)) {
    throw new WorkspaceNameError("WORKSPACE_NAME_INVALID", "Workspace name cannot contain control characters.");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new WorkspaceNameError("WORKSPACE_NAME_INVALID", "Workspace name cannot contain path separators.");
  }
  if (name.startsWith(".")) {
    // Blocks ".", "..", and dotfile-style names that would otherwise shadow store metadata files.
    throw new WorkspaceNameError("WORKSPACE_NAME_INVALID", "Workspace name cannot start with a dot.");
  }
  // Defense in depth: even with the checks above, confirm the name can't escape the workspaces root.
  const dir = path.join(WORKSPACES_ROOT, name);
  if (!dir.startsWith(WORKSPACES_ROOT + path.sep)) {
    throw new WorkspaceNameError("WORKSPACE_NAME_INVALID", `Invalid workspace name: "${raw}".`);
  }
  return name;
}

// NFC, trimmed, case-folded, so "Sales" and "sales" can't coexist while call_agent and /api/agent
// still address workspaces by name.
export function normalizeForUniqueness(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}
