// In-process "something changed" signals for clients that follow the whole app (the VS Code extension),
// on `global` like wsHub.ts so hot reloads keep one hub. Payloads are ids only: clients refetch.
import { createLogger } from "../logger";

export type AppEvent =
  | { type: "workspaces_changed" }
  | { type: "conversations_changed"; workspaceId: string }
  | { type: "run_started" | "run_ended"; workspaceId: string; conversationId: string };

type Listener = (event: AppEvent) => void;

const log = createLogger("events");
const g = global as typeof global & { _appEventListeners?: Set<Listener> };
const listeners = (g._appEventListeners ??= new Set());

/** Never throws: a broken listener must not fail the change that published. */
export function publish(event: AppEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      log.debug({ err, eventType: event.type }, "event listener failed");
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

export function listenerCount(): number {
  return listeners.size;
}
