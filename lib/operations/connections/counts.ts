// Connection counts on every workspace and drive read, so `0` is stated rather than implied. They count
// reachability: duplicates once, dead ends zero. Details live in the connection listing.
import { getStore } from "@/lib/infra/services";
import { getGraph, type GraphEdge } from "@/lib/agent/graph";
import { getDrivesForWorkspace, listConnections, type DriveConnection } from "@/lib/drives/store";

export interface WorkspaceConnectionCounts {
  /** Drives this workspace can address by name, which is what resolveDriveDir resolves against. */
  drives: number;
  /** Workspaces that may call this one. */
  callers: number;
  /** Workspaces this one may call. Delegation is one-way, so the two rarely match. */
  callees: number;
}

export interface DriveConnectionCounts {
  workspaces: number;
}

export interface ConnectionCountDeps {
  drivesForWorkspace(workspaceId: string): unknown[];
  connections(): DriveConnection[];
  edges(): GraphEdge[];
  workspaceExists(workspaceId: string): boolean;
}

function defaultDeps(): ConnectionCountDeps {
  return {
    drivesForWorkspace: getDrivesForWorkspace,
    connections: listConnections,
    edges: () => getGraph().edges,
    workspaceExists: (workspaceId) => getStore().getWorkspace(workspaceId) !== undefined,
  };
}

// Distinct ends that still exist: the graph accepts a pair twice, and neither store refuses an id
// nothing answers to, so counting rows would report reach this workspace does not have.
function reachable(ids: string[], exists: (id: string) => boolean): number {
  return new Set(ids.filter(exists)).size;
}

export function workspaceConnectionCounts(
  workspaceId: string,
  deps: ConnectionCountDeps = defaultDeps(),
): WorkspaceConnectionCounts {
  const edges = deps.edges();
  const ends = (kept: (edge: GraphEdge) => boolean, end: (edge: GraphEdge) => string) =>
    reachable(edges.filter(kept).map(end), deps.workspaceExists);
  return {
    // Already distinct and already narrowed to drives that exist — the store owns that rule because
    // the agent's own name resolution is built on the same call.
    drives: deps.drivesForWorkspace(workspaceId).length,
    callers: ends(
      (edge) => edge.target === workspaceId,
      (edge) => edge.source,
    ),
    callees: ends(
      (edge) => edge.source === workspaceId,
      (edge) => edge.target,
    ),
  };
}

export function driveConnectionCounts(
  driveId: string,
  deps: ConnectionCountDeps = defaultDeps(),
): DriveConnectionCounts {
  const workspaceIds = deps
    .connections()
    .filter((connection) => connection.driveId === driveId)
    .map((connection) => connection.workspaceId);
  return { workspaces: reachable(workspaceIds, deps.workspaceExists) };
}
