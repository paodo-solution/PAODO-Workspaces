// Drive metadata operations: a named drive must exist, and saying so is the operation's job, not each route's.
// Deps are injected (as in connect.ts) for testing.
import { AppError, requireNonEmptyString, requireString } from "@/lib/errors/appError";
import * as store from "@/lib/drives/store";
import type { Drive } from "@/lib/drives/store";

export interface CreateDriveInput {
  name?: unknown;
  description?: unknown;
}

export interface UpdateDriveInput {
  name?: unknown;
  description?: unknown;
}

export interface DeleteDriveResult {
  deleted: true;
}

/** The fields a drive PATCH may move, and what each one now holds. */
export interface DriveUpdateValues {
  name?: string;
  description?: string;
}

// Same shape as a workspace PATCH receipt. `applied` holds stored values, not the request, since names
// are trimmed and NFC-folded.
export interface DriveUpdateReceipt {
  ok: true;
  driveId: string;
  applied: DriveUpdateValues;
}

/** Narrower than the drive store: the five metadata calls and nothing else. */
export interface DriveDeps {
  list(): Drive[];
  get(driveId: string): Drive | undefined;
  create(name: string, description?: string): Drive;
  update(driveId: string, patch: { name?: string; description?: string }): Drive | undefined;
  remove(driveId: string): Promise<boolean>;
}

function defaultDeps(): DriveDeps {
  return {
    list: store.listDrives,
    get: store.getDrive,
    create: store.createDrive,
    update: store.updateDrive,
    remove: store.deleteDrive,
  };
}

function notFound(driveId: string): AppError {
  return new AppError("NOT_FOUND", `drive ${driveId} not found`, { field: "driveId" });
}

/** An optional string field: absent means unchanged, and a non-string is the caller's to fix. */
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AppError("INVALID_REQUEST", `${field} must be a string`, { field });
  }
  return value;
}

export function listDrives(deps: DriveDeps = defaultDeps()): Drive[] {
  return deps.list();
}

export function getDrive(driveIdValue: unknown, deps: DriveDeps = defaultDeps()): Drive {
  const driveId = requireNonEmptyString(driveIdValue, "driveId");
  const drive = deps.get(driveId);
  if (!drive) throw notFound(driveId);
  return drive;
}

// Only checks the name is non-blank; its content rules live in lib/drives/name.ts and come back as
// DRIVE_NAME_INVALID or DRIVE_NAME_CONFLICT.
export function createDrive(input: CreateDriveInput, deps: DriveDeps = defaultDeps()): Drive {
  const name = requireNonEmptyString(input.name, "name");
  return deps.create(name, optionalString(input.description, "description"));
}

export const UPDATABLE_FIELDS = ["name", "description"] as const;

// Omitted means unchanged; an empty description clears it. Unknown fields are refused with the
// accepted list, so a typo can't half-apply and report `ok`.
export function updateDrive(
  driveIdValue: unknown,
  input: UpdateDriveInput,
  deps: DriveDeps = defaultDeps(),
): DriveUpdateReceipt {
  const driveId = requireNonEmptyString(driveIdValue, "driveId");
  const fields = UPDATABLE_FIELDS as readonly string[];
  const unknown = Object.keys(input).filter((key) => !fields.includes(key));
  if (unknown.length > 0) {
    throw new AppError("INVALID_REQUEST", `unknown field(s): ${unknown.join(", ")} — accepted: ${fields.join(", ")}`, {
      fields: unknown,
      acceptedFields: [...UPDATABLE_FIELDS],
    });
  }
  if (fields.every((field) => input[field as keyof UpdateDriveInput] === undefined)) {
    throw new AppError("INVALID_REQUEST", `no fields supplied — send at least one of: ${fields.join(", ")}`, {
      acceptedFields: [...UPDATABLE_FIELDS],
    });
  }
  const patch = {
    ...(input.name === undefined ? {} : { name: requireNonEmptyString(input.name, "name") }),
    ...(input.description === undefined ? {} : { description: requireString(input.description, "description") }),
  };
  const drive = deps.update(driveId, patch);
  if (!drive) throw notFound(driveId);
  return {
    ok: true,
    driveId,
    applied: {
      ...(patch.name === undefined ? {} : { name: drive.name }),
      // "" rather than the store's `undefined` for a cleared description: JSON drops an undefined
      // value, which would report an applied field as one that was never sent.
      ...(patch.description === undefined ? {} : { description: drive.description ?? "" }),
    },
  };
}

// Removes the drive, its connections and files. Raises NOT_FOUND like a workspace DELETE, so success
// always names something real.
export async function deleteDrive(driveIdValue: unknown, deps: DriveDeps = defaultDeps()): Promise<DeleteDriveResult> {
  const driveId = requireNonEmptyString(driveIdValue, "driveId");
  if (!(await deps.remove(driveId))) throw notFound(driveId);
  return { deleted: true };
}
