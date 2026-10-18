import type { FileWriteHooks } from "@/lib/operations/files/content";

// Storage hooks shared by workspace and drive file endpoints. `dir` is the only place the host layout
// appears, and nothing derived from it reaches a response.
export interface FileBackend extends FileWriteHooks {
  dir: string;
  logContext: Record<string, unknown>;
}
