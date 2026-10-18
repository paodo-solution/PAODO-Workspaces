// Versioning singleton in its own module, so the registry can use it without importing services.ts (a cycle).
import { WorkspaceVersioning } from "./workspaceVersioning";

export const defaultWorkspaceVersioning = new WorkspaceVersioning();
