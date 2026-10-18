import type { FileWriteHooks } from "@/lib/operations/files/content";

/**
 * Storage and mutation hooks shared by the workspace and drive file endpoints.
 *
 * `dir` is the host directory the wire-space relative paths resolve against, and it is the only place
 * the host layout appears — nothing derived from it reaches a response. See lib/files/relpath.ts.
 */
export interface FileBackend extends FileWriteHooks {
  dir: string;
  logContext: Record<string, unknown>;
}
