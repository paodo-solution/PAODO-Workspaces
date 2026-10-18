// The rendered message shape, produced both by the server (stored history) and the client (live events), so
// it belongs to neither. Dependency-free.

export interface Message {
  role: "user" | "assistant" | "tool_start" | "error" | "limit_notice" | "reasoning" | "usage" | "disconnected";
  content?: string;
  toolName?: string;
  // The provider's tool_call id, when it supplied one. Identifies which bubble a later
  // tool_link/tool_result belongs to when one turn opens several bubbles for the same tool.
  toolCallId?: string;
  toolSummary?: string;
  toolDone?: boolean;
  // Set only on a completed call_agent tool bubble: deep-link to the callee's persisted session.
  calleeWorkspaceId?: string;
  calleeWorkspaceName?: string;
  calleeConversationId?: string;
  thinking?: boolean;
  inputTokensTotal?: number;
  inputTokensCacheRead?: number;
  outputTokensTotal?: number;
}
