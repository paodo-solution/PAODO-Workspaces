// Reconnecting workspace WebSocket that dispatches messages through the handler map (add a key for a new type).
// Handlers sit in a ref, so re-renders never reconnect.
"use client";

import { useEffect, useRef, useCallback } from "react";
import { wsReconnectDelayMs } from "@/lib/client/wsReconnect";

export type WsMessage = { type: string; paths?: string[]; [key: string]: unknown };
export type HandlerMap = { [type: string]: (msg: WsMessage) => void };

export interface WorkspaceSocketHandle {
  sendMessage: (msg: object) => void;
}

export function useWorkspaceSocket(workspaceId: string, handlers: HandlerMap): WorkspaceSocketHandle {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef<HandlerMap>(handlers);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Set to true when the workspaceId lifecycle ends (unmount or workspaceId change) to stop reconnects.
  const cancelledRef = useRef(false);

  // Updated in an effect so the ref only holds committed handlers; it's read in onmessage, long after.
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    cancelledRef.current = false;
    // Consecutive failures, reset on a successful open. Drives the backoff so a handshake the
    // browser cannot satisfy costs one request per 30s instead of one every 2s, forever.
    let attempt = 0;

    function connect() {
      const ws = new WebSocket(
        `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws?workspaceId=${workspaceId}`,
      );
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        pingRef.current = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, 30_000);
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as WsMessage;
          handlersRef.current[msg.type]?.(msg);
        } catch {
          /* ignore malformed */
        }
      };

      ws.onclose = () => {
        if (pingRef.current) {
          clearInterval(pingRef.current);
          pingRef.current = null;
        }
        // wsRef.current === ws guards against reconnects from a stale socket after workspaceId change.
        if (!cancelledRef.current && wsRef.current === ws) {
          attempt += 1;
          reconnectRef.current = setTimeout(connect, wsReconnectDelayMs(attempt));
        }
      };
    }

    connect();

    return () => {
      cancelledRef.current = true;
      if (reconnectRef.current) {
        clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      if (pingRef.current) {
        clearInterval(pingRef.current);
        pingRef.current = null;
      }
      const ws = wsRef.current;
      if (ws) {
        // Null the ref first so onclose (which fires async) sees wsRef.current !== ws and skips reconnect.
        wsRef.current = null;
        if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
        else ws.close();
      }
    };
  }, [workspaceId]);

  const sendMessage = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { sendMessage };
}
