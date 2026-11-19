// The audit line a file transfer or deletion leaves, named after the space it touched: `workspace_files_pushed`,
// `drive_file_deleted`… The request's caller (vscode, cli, browser) comes from the log context.
import { createAuditLogger } from "@/lib/infra/logger";
import type { FileBackend } from "./backend";

const audit = createAuditLogger("files");

export function auditFiles(
  be: FileBackend,
  action: "files_pulled" | "files_pushed" | "file_deleted",
  fields: object,
): void {
  const space = "workspaceId" in be.logContext ? "workspace" : "drive";
  audit.info(
    { ...be.logContext, event: `${space}_${action}`, outcome: "succeeded", ...fields },
    `${space} ${action.replace("_", " ")}`,
  );
}
