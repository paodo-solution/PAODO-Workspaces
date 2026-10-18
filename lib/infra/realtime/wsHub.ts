// Registry of live WebSocket connections shared by the custom server and API routes, on `global` so hot
// reloads don't drop them.
import type { WebSocket } from "ws";
import { WS_MAX_BUFFERED_BYTES, WS_STALL_MS } from "../limits";

const g = global as typeof global & { _wsConnections?: Map<string, Set<WebSocket>> };
if (!g._wsConnections) g._wsConnections = new Map();

const connections = g._wsConnections;

// ws.send() never blocks, so a slow client queues on our heap; sends are bounded by the limits in
// lib/infra/limits.ts.

// Per-socket drop bookkeeping. WeakMap so an entry cannot outlive the socket it describes — this map
// is never cleaned up on disconnect, and must not be a reason a closed connection stays reachable.
const lagging = new WeakMap<WebSocket, { dropped: number; overSince: number }>();

/**
 * Send unless the socket is already too far behind, in which case drop the message instead of
 * queueing it. Every write to a client goes through here — a bound that some paths skip is not a
 * bound, since one unbounded caller is all it takes.
 */
/** Whether this socket is currently draining fast enough to be given more. */
function keepingUp(ws: WebSocket): boolean {
  return ws.readyState === 1 /* OPEN */ && ws.bufferedAmount <= WS_MAX_BUFFERED_BYTES;
}

function sendBounded(ws: WebSocket, data: string): void {
  const state = lagging.get(ws);

  if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) {
    const now = Date.now();
    if (!state) {
      lagging.set(ws, { dropped: 1, overSince: now });
      return;
    }
    state.dropped++;
    if (now - state.overSince >= WS_STALL_MS) {
      lagging.delete(ws);
      ws.terminate();
    }
    return;
  }

  if (state) {
    // Recovered. Tell the truth about the gap before resuming, so the console shows a break rather
    // than silently splicing two unrelated stretches of output together.
    lagging.delete(ws);
    ws.send(JSON.stringify({ type: "console_dropped", dropped: state.dropped }));
  }
  ws.send(data);
}

export function addConnection(workspaceId: string, ws: WebSocket): void {
  if (!connections.has(workspaceId)) connections.set(workspaceId, new Set());
  connections.get(workspaceId)!.add(ws);
}

export function removeConnection(workspaceId: string, ws: WebSocket): void {
  const set = connections.get(workspaceId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) connections.delete(workspaceId);
}

export function getConnectionCount(workspaceId: string): number {
  return connections.get(workspaceId)?.size ?? 0;
}

export function broadcastToWorkspace(workspaceId: string, data: string): void {
  const sockets = connections.get(workspaceId);
  if (!sockets) return;
  for (const ws of sockets) {
    if (ws.readyState === 1 /* OPEN */) sendBounded(ws, data);
  }
}

/**
 * Send to ONE connection for this workspace (the agent runner's notify seam).
 * Returns false when there is nobody connected — a run continues with no one watching.
 *
 * Prefers a socket that is keeping up rather than the first open one in iteration order. With two
 * tabs open, that order could put a backgrounded tab first, and the ceiling then turned every
 * tool_call and tool_result_log of the run into a drop while a foreground tab sat there draining
 * fine. The bound has to cost the tab that is behind, not the one that is watching.
 */
export function sendToWorkspace(workspaceId: string, data: string): boolean {
  const sockets = connections.get(workspaceId);
  if (!sockets) return false;
  let behind: WebSocket | null = null;
  for (const ws of sockets) {
    if (keepingUp(ws)) {
      sendBounded(ws, data);
      return true;
    }
    if (ws.readyState === 1 && !behind) behind = ws;
  }
  // Everyone connected is over the ceiling. Still go through sendBounded: it drops rather than
  // queues, and it is what accrues the stall bookkeeping that eventually lets a dead socket go.
  if (!behind) return false;
  sendBounded(behind, data);
  return true;
}
