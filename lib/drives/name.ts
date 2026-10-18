// Drive-name policy: the rules, the uniqueness fold, and the typed error both the store and the API
// routes use. Deliberately the mirror of lib/workspace/name.ts — see validateDriveName.
import path from "path";
import { AppError } from "../errors/appError";

export const MAX_DRIVE_NAME_LENGTH = 100;

/** Where drive_download lands a drive's files inside a workspace (lib/agent/tools/driveDownload.ts). */
const DOWNLOADS_ROOT = "downloads";

export type DriveNameErrorCode = "DRIVE_NAME_INVALID" | "DRIVE_NAME_CONFLICT";

/** Thrown for both malformed names (INVALID) and collisions (CONFLICT); routes map code → status. */
export class DriveNameError extends AppError {
  constructor(
    readonly code: DriveNameErrorCode,
    message: string,
  ) {
    super(code, message);
    this.name = "DriveNameError";
  }
}

function invalid(message: string): DriveNameError {
  return new DriveNameError("DRIVE_NAME_INVALID", message);
}

// Control chars (C0 range + DEL) that must never appear in a filesystem-facing or displayed name.
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

// Returns the trimmed NFC name or throws DRIVE_NAME_INVALID. Held to workspace-name rules since it
// becomes downloads/<drive-name>/; the string check stops a TypeError 500.
export function validateDriveName(raw: string): string {
  if (typeof raw !== "string") throw invalid("Drive name must be a string.");
  const name = raw.trim().normalize("NFC");

  if (!name) throw invalid("Drive name cannot be empty.");
  if (name.length > MAX_DRIVE_NAME_LENGTH) {
    throw invalid(`Drive name cannot exceed ${MAX_DRIVE_NAME_LENGTH} characters.`);
  }
  if (CONTROL_CHARS.test(name)) throw invalid("Drive name cannot contain control characters.");
  if (name.includes("/") || name.includes("\\")) throw invalid("Drive name cannot contain path separators.");
  // Blocks ".", "..", and dotfile-style names that would shadow a workspace's own dot-directories
  // once drive_download materializes the drive at downloads/<drive-name>/.
  if (name.startsWith(".")) throw invalid("Drive name cannot start with a dot.");
  // Defense in depth: even with the checks above, confirm the name stays inside downloads/.
  const dir = path.posix.join(DOWNLOADS_ROOT, name);
  if (!dir.startsWith(`${DOWNLOADS_ROOT}/`)) throw invalid(`Invalid drive name: "${raw}".`);
  return name;
}

// NFC, trimmed, case-folded: drive tools match names case-insensitively, and duplicates would overwrite
// each other under downloads/.
export function normalizeForUniqueness(name: string): string {
  return name.trim().normalize("NFC").toLowerCase();
}
