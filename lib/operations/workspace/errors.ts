// The workspace layer's two failure kinds, separate so capability files can throw them without importing update.ts.
import { AppError, type ErrorDetails } from "@/lib/errors/appError";

/** A caller error that adapters translate into their transport's invalid-input response. */
export class WorkspaceUpdateError extends AppError {
  constructor(message: string, details?: ErrorDetails) {
    super("WORKSPACE_UPDATE_INVALID", message, details);
    this.name = "WorkspaceUpdateError";
  }
}

/** An operational failure safe for adapters to surface without exposing its underlying exception. */
export class WorkspaceUpdateFailure extends AppError {
  constructor(message: string) {
    super("WORKSPACE_UPDATE_FAILED", message);
    this.name = "WorkspaceUpdateFailure";
  }
}
