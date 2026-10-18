import type { ToolStatus } from "@/lib/usage/types";

// Every tool's catch funnels through here: classifyToolStatus reads the leading "Error:" to mark failures.
export function toolError(err: unknown): string {
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

// Classifies the final result string: "Error:" or "Permission denied:" fail, "Needs input:" is the A2A retry
// state.
export function classifyToolStatus(resultStr: string): ToolStatus {
  if (/^Needs input:/.test(resultStr)) return "needs_input";
  if (/^(Error\b|Error \(|Permission denied)/.test(resultStr)) return "error";
  return "ok";
}
