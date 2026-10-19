import type { ReasoningEffort } from "../models/llmSelection";

/** The workspace entity shared by operations, runtime consumers, and persistence adapters. */
export interface Workspace {
  id: string;
  name: string;
  dir: string;
  createdAt: Date;
  maxIterations: number;
  /** Wall-clock limit for one run, including model, tool, validation, and child-agent wait time. */
  maxRunMinutes: number;
  /** Workspace-level context shown in the UI and exposed to external MCP clients as instructions. */
  description?: string;
  llmProvider?: string;
  llmModel?: string;
  reasoningEffort?: ReasoningEffort;
  /** Whether the workspace container is permitted to route traffic to the internet. */
  internetAccess: boolean;
  /** Absent means unrestricted. Kept while `restricted` is off, so turning it back on restores the list. */
  domainAllowlist?: DomainAllowlist;
}

// Hosts the container may reach while internet access is on, matched exactly. An empty list restricts
// nothing until a domain is added (see enforcedDomains).
export interface DomainAllowlist {
  restricted: boolean;
  domains: string[];
}
