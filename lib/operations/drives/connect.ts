// Drive↔workspace connections, which must reference two existing entities: the store can't check the
// workspace side, and agents and the graph act on every connection. Input is validated before lookups.
import { AppError, requireNonEmptyString } from "@/lib/errors/appError";
import { connectDrive, disconnectDrive, getDrive, type DriveConnection } from "@/lib/drives/store";
import { getStore } from "@/lib/infra/services";
import { connectionKind } from "@/lib/connections/ids";

export interface ConnectDriveInput {
  driveId?: unknown;
  workspaceId?: unknown;
  /** The graph editor's attachment points, replayed so a saved edge redraws where it was dropped. */
  sourceHandle?: unknown;
  targetHandle?: unknown;
}

export interface DisconnectDriveInput {
  connectionId?: unknown;
}

export interface DisconnectDriveResult {
  deleted: boolean;
}

/** Narrower than the drive store and the workspace store: existence, and the two writes. */
export interface DriveConnectionDeps {
  driveExists(driveId: string): boolean;
  workspaceExists(workspaceId: string): boolean;
  connect: typeof connectDrive;
  disconnect: typeof disconnectDrive;
}

function defaultDeps(): DriveConnectionDeps {
  return {
    driveExists: (driveId) => getDrive(driveId) !== undefined,
    workspaceExists: (workspaceId) => getStore().getWorkspace(workspaceId) !== undefined,
    connect: connectDrive,
    disconnect: disconnectDrive,
  };
}

/** A handle is optional; absent and null both mean "no handle recorded". */
function optionalHandle(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new AppError("INVALID_REQUEST", `${field} must be a string`, { field });
  }
  return value;
}

/**
 * Connect a drive to a workspace, or move an existing link's handles. Reconnecting the same pair is
 * deliberately not an error — the store keeps one link per pair and updates its handles — so the
 * graph editor can save a moved edge without first deleting it.
 */
export function connectDriveToWorkspace(
  input: ConnectDriveInput,
  deps: DriveConnectionDeps = defaultDeps(),
): DriveConnection {
  const driveId = requireNonEmptyString(input.driveId, "driveId");
  const workspaceId = requireNonEmptyString(input.workspaceId, "workspaceId");
  const sourceHandle = optionalHandle(input.sourceHandle, "sourceHandle");
  const targetHandle = optionalHandle(input.targetHandle, "targetHandle");

  if (!deps.driveExists(driveId)) {
    throw new AppError("NOT_FOUND", `drive ${driveId} not found`, { field: "driveId" });
  }
  if (!deps.workspaceExists(workspaceId)) {
    throw new AppError("NOT_FOUND", `workspace ${workspaceId} not found`, { field: "workspaceId" });
  }

  return deps.connect(driveId, workspaceId, { sourceHandle, targetHandle });
}

/**
 * Remove one connection. An unknown id reports `deleted: false` rather than raising: the caller
 * asked for a state this leaves established, and the graph editor prunes links it believes are
 * stale, which races with a drive deletion that already dropped them.
 */
export function disconnectDriveFromWorkspace(
  input: DisconnectDriveInput,
  deps: DriveConnectionDeps = defaultDeps(),
): DisconnectDriveResult {
  const connectionId = requireNonEmptyString(input.connectionId, "connectionId");
  // An id from the wrong graph is refused by name; `deleted: false` would tell its caller nothing.
  if (connectionKind(connectionId) !== "link") {
    throw new AppError("INVALID_REQUEST", "connectionId must be a drive link id, which starts with link_", {
      field: "connectionId",
    });
  }
  return { deleted: deps.disconnect(connectionId) };
}
