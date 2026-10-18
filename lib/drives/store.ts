// Shared drives and their workspace connections. Content lives in data/.drives/<id>/, never mounted into a
// container. Separate from the agent-call graph; read fresh from disk so every module instance agrees.
import path from "path";
import fs from "fs";
import { rm } from "fs/promises";
import { drivesRegistryFile, driveConnectionsFile, drivesContentDir } from "../infra/paths";
import { atomicSaveJson } from "../infra/jsonPersist";
import { createLogger } from "../infra/logger";
import { DriveNameError, normalizeForUniqueness, validateDriveName } from "./name";
import { mintConnectionId } from "../connections/ids";

const log = createLogger("driveStore");

export interface Drive {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

export interface DriveConnection {
  id: string;
  driveId: string;
  workspaceId: string;
  sourceHandle?: string;
  targetHandle?: string;
}

const DRIVES_FILE = drivesRegistryFile();
const CONNECTIONS_FILE = driveConnectionsFile();
const DRIVES_DIR = drivesContentDir();

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (err) {
    // Missing files are normal before the first drive/connection is created. Corruption,
    // permissions, and other I/O failures must not make every drive silently disappear.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log.error(
        { event: "drive_registry_load_failed", outcome: "fallback_used", err, filePath: file },
        "failed to load drive registry — using fallback",
      );
    }
    return fallback;
  }
}

/** Absolute host path holding a drive's files. Keyed by UUID, so it is rename-safe. */
export function driveContentDir(driveId: string): string {
  return path.join(DRIVES_DIR, driveId);
}

// `- <name> (id: <id>)<desc>`, with the id as a stable handle agents can pass on. Shared by the system
// prompt and drive_ls so they never drift.
export function formatDriveLine(drive: Drive): string {
  return `- ${drive.name} (id: ${drive.id})${drive.description ? ` — ${drive.description}` : ""}`;
}

export function listDrives(): Drive[] {
  return readJson<Drive[]>(DRIVES_FILE, []);
}

export function listConnections(): DriveConnection[] {
  return readJson<DriveConnection[]>(CONNECTIONS_FILE, []);
}

export function getDrive(driveId: string): Drive | undefined {
  return listDrives().find((d) => d.id === driveId);
}

function saveConnections(
  connections: DriveConnection[],
  context: { operation: string; connectionId?: string; driveId?: string; workspaceId?: string },
): void {
  try {
    atomicSaveJson(CONNECTIONS_FILE, connections);
  } catch (err) {
    log.error(
      {
        event: "drive_connection_save_failed",
        outcome: "drive_connection_change_not_persisted",
        err,
        filePath: CONNECTIONS_FILE,
        ...context,
      },
      "failed to save drive connection change",
    );
    throw err;
  }
}

// Throws DRIVE_NAME_CONFLICT if another drive has the same folded name; otherwise name lookups and
// downloads/<drive-name>/ would pick one arbitrarily.
function assertNameAvailable(name: string, drives: Drive[], exceptId?: string): void {
  const key = normalizeForUniqueness(name);
  for (const drive of drives) {
    if (drive.id !== exceptId && normalizeForUniqueness(drive.name) === key) {
      throw new DriveNameError("DRIVE_NAME_CONFLICT", `A drive named "${name}" already exists.`);
    }
  }
}

export function createDrive(name: string, description?: string): Drive {
  const drives = listDrives();
  const drive: Drive = {
    id: crypto.randomUUID(),
    name: validateDriveName(name),
    description: description?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  // Before mkdir, so a refused name leaves no orphan content directory behind.
  assertNameAvailable(drive.name, drives);
  fs.mkdirSync(driveContentDir(drive.id), { recursive: true });
  drives.push(drive);
  atomicSaveJson(DRIVES_FILE, drives);
  log.info({ id: drive.id, name: drive.name }, "created drive");
  return drive;
}

export function updateDrive(driveId: string, patch: { name?: string; description?: string }): Drive | undefined {
  const drives = listDrives();
  const drive = drives.find((d) => d.id === driveId);
  if (!drive) return undefined;
  if (patch.name !== undefined) {
    const name = validateDriveName(patch.name);
    // `driveId` excepted, so renaming a drive to the name it already holds is not a conflict.
    assertNameAvailable(name, drives, driveId);
    drive.name = name;
  }
  if (patch.description !== undefined) {
    drive.description = patch.description.trim() || undefined;
  }
  atomicSaveJson(DRIVES_FILE, drives);
  return drive;
}

// Content, connections, registry — in that order. Content is the only step that can fail, and the
// connections are the sole record of what was linked; the registry entry stays last as the retry handle.
export async function deleteDrive(driveId: string): Promise<boolean> {
  if (!listDrives().some((d) => d.id === driveId)) return false;

  await rm(driveContentDir(driveId), { recursive: true, force: true });

  // Re-read, not filtered from a snapshot above: `rm` is the one yield point, and a drive created
  // while it ran is absent from any older copy.
  saveConnections(
    listConnections().filter((c) => c.driveId !== driveId),
    { operation: "delete_drive", driveId },
  );
  atomicSaveJson(
    DRIVES_FILE,
    listDrives().filter((d) => d.id !== driveId),
  );
  log.info({ driveId }, "deleted drive");
  return true;
}

// Connect a drive to a workspace. Only one link per pair exists; reconnecting updates the chosen
// handle positions so the rendered edge stays where the user attached it.
export function connectDrive(
  driveId: string,
  workspaceId: string,
  handles?: { sourceHandle?: string; targetHandle?: string },
): DriveConnection {
  const connections = listConnections();
  const existing = connections.find((c) => c.driveId === driveId && c.workspaceId === workspaceId);
  if (existing) {
    existing.sourceHandle = handles?.sourceHandle;
    existing.targetHandle = handles?.targetHandle;
    saveConnections(connections, {
      operation: "update_connection_handles",
      connectionId: existing.id,
      driveId,
      workspaceId,
    });
    return existing;
  }
  const connection: DriveConnection = {
    id: mintConnectionId("link"),
    driveId,
    workspaceId,
    sourceHandle: handles?.sourceHandle,
    targetHandle: handles?.targetHandle,
  };
  connections.push(connection);
  saveConnections(connections, {
    operation: "connect_drive",
    connectionId: connection.id,
    driveId,
    workspaceId,
  });
  return connection;
}

export function disconnectDrive(connectionId: string): boolean {
  const connections = listConnections();
  const connection = connections.find((candidate) => candidate.id === connectionId);
  const next = connections.filter((c) => c.id !== connectionId);
  if (next.length === connections.length) return false;
  saveConnections(next, {
    operation: "disconnect_drive",
    connectionId,
    driveId: connection?.driveId,
    workspaceId: connection?.workspaceId,
  });
  return true;
}

/** Remove all drive connections for a deleted workspace. */
export function disconnectWorkspace(workspaceId: string): void {
  const connections = listConnections();
  const next = connections.filter((c) => c.workspaceId !== workspaceId);
  if (next.length !== connections.length) {
    saveConnections(next, { operation: "disconnect_workspace", workspaceId });
  }
}

/** Drives connected to a given workspace — the set an agent can see and address by name. */
export function getDrivesForWorkspace(workspaceId: string): Drive[] {
  const driveIds = new Set(
    listConnections()
      .filter((c) => c.workspaceId === workspaceId)
      .map((c) => c.driveId),
  );
  return listDrives().filter((d) => driveIds.has(d.id));
}

// Resolves an id (stable, what agents pass on) or a case-insensitive name to a drive connected to this
// workspace, or null.
export function resolveDriveDir(workspaceId: string, driveRef: string): { drive: Drive; dir: string } | null {
  const ref = driveRef.trim();
  const wantedName = ref.toLowerCase();
  const drive = getDrivesForWorkspace(workspaceId).find((d) => d.id === ref || d.name.toLowerCase() === wantedName);
  if (!drive) return null;
  return { drive, dir: driveContentDir(drive.id) };
}
