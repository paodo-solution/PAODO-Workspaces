// Stable failures that may cross an application boundary. Codes are for programs; messages are for
// people. Once published, a code keeps its meaning even when its wording improves.
export const ERROR_CODES = {
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  /** The request was valid but lost a race — the thing it named changed underneath it. */
  CONFLICT: "CONFLICT",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  RATE_LIMITED: "RATE_LIMITED",
  /** The instance-wide active-agent fuse is full. The request is safe to retry after a run ends. */
  CAPACITY_REACHED: "CAPACITY_REACHED",
  // The filesystem refused the write. Not FORBIDDEN, since 403 already means a CSRF rejection here.
  FILE_NOT_WRITABLE: "FILE_NOT_WRITABLE",
  /** Over MAX_UPLOAD_BYTES, which is our own policy — hence FILE_, not the 413 status name. */
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  // The whole transfer exceeded an entry or byte cap. Not FILE_TOO_LARGE: the fix is splitting the
  // transfer, not one file.
  TRANSFER_TOO_LARGE: "TRANSFER_TOO_LARGE",
  STORAGE_EXHAUSTED: "STORAGE_EXHAUSTED",
  WORKSPACE_NAME_INVALID: "WORKSPACE_NAME_INVALID",
  WORKSPACE_NAME_CONFLICT: "WORKSPACE_NAME_CONFLICT",
  WORKSPACE_UPDATE_INVALID: "WORKSPACE_UPDATE_INVALID",
  WORKSPACE_UPDATE_FAILED: "WORKSPACE_UPDATE_FAILED",
  // A secret sent to a route that doesn't write secrets. Its own code, so a program learns the field
  // is real but belongs to its own endpoint.
  WORKSPACE_SECRET_FORBIDDEN: "WORKSPACE_SECRET_FORBIDDEN",
  DRIVE_NAME_INVALID: "DRIVE_NAME_INVALID",
  // Drive names are unique by folded key: agent tools address drives by name and download them to
  // downloads/<drive-name>/.
  DRIVE_NAME_CONFLICT: "DRIVE_NAME_CONFLICT",
  SCHEDULE_INVALID: "SCHEDULE_INVALID",
  CREDENTIAL_ALREADY_CONFIGURED: "CREDENTIAL_ALREADY_CONFIGURED",
  CREDENTIAL_NOT_CONFIGURED: "CREDENTIAL_NOT_CONFIGURED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type AppErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
export type ErrorDetails = Record<string, unknown>;

export interface PublicErrorBody {
  ok: false;
  code: AppErrorCode;
  error: string;
  details?: ErrorDetails;
  requestId?: string;
}

/** Pure wire-envelope builder, also usable by the custom HTTP server before Next.js is entered. */
export function publicErrorBody(
  code: AppErrorCode,
  error: string,
  options: { details?: ErrorDetails; requestId?: string } = {},
): PublicErrorBody {
  return {
    ok: false,
    code,
    error,
    ...(options.details ? { details: options.details } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
  };
}

/** A safe, expected application failure. Its cause stays private; adapters may expose these fields. */
export class AppError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = "AppError";
  }
}

// A present value that must be a string. Callers with their own error type (e.g. a capability-specific
// AppError subclass) pass `fail` instead of taking the default INVALID_REQUEST.
export function requireString(
  value: unknown,
  field: string,
  fail: (message: string) => Error = (message) => new AppError("INVALID_REQUEST", message, { field }),
): string {
  if (typeof value !== "string") throw fail(`${field} must be a string`);
  return value;
}

// The "id/name is required" guard. Non-strings are refused, not coerced, so a wrong type is a bad
// request rather than a misleading not-found.
export function requireNonEmptyString(
  value: unknown,
  field: string,
  fail: (message: string) => Error = (message) => new AppError("INVALID_REQUEST", message, { field }),
): string {
  if (typeof value !== "string" || !value.trim()) throw fail(`${field} is required`);
  return value;
}
