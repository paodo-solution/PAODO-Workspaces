// Tool labels and argument summaries shared by chat, dashboard and history projection, so every surface
// describes a call the same way. Dependency-free.

// Extend this map to support new tools without modifying dispatch logic (OCP).
const TOOL_LABELS: Record<string, string> = {
  file_read: "Reading file",
  file_write: "Writing file",
  file_edit: "Editing file",
  execute_command: "Running command",
  http_get: "Fetching page",
  todo_write: "Updating tasks",
  glob: "Searching files",
  list_directory: "Listing directory",
};

type ArgExtractor = (args: Record<string, unknown>) => string;
const TOOL_ARG_SUMMARY: Record<string, ArgExtractor> = {
  execute_command: (a) => String(a.command ?? ""),
  file_read: (a) => String(a.file_path ?? ""),
  file_write: (a) => String(a.file_path ?? ""),
  file_edit: (a) => String(a.file_path ?? ""),
  glob: (a) => String(a.pattern ?? ""),
  list_directory: (a) => String(a.dir_path ?? "") || ".",
  http_get: (a) => String(a.url ?? ""),
  call_agent: (a) => `→ ${String(a.workspace ?? "")}${a.action ? ` · ${String(a.action)}` : ""}`,
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

export function toolArgSummary(name: string, args: Record<string, unknown>): string {
  return TOOL_ARG_SUMMARY[name]?.(args) ?? "";
}
