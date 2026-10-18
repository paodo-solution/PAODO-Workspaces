// Pure reducers folding AgentEvents into the chat's message list (no React, so plain node tests work);
// useAgentStream owns state and repaints. The Message shape lives in lib/transcript/, shared with the server.
import type { AgentEvent } from "@/lib/agent/runner";
import type { CallAgentMeta } from "@/lib/agent/tools/agentCall";
import type { Message } from "@/lib/transcript/message";
import { toolArgSummary } from "@/lib/transcript/toolDisplay";

export type { Message };

export interface TranscriptState {
  messages: Message[];
}

export const emptyTranscript = (): TranscriptState => ({ messages: [] });

type TurnUsageEvent = Extract<AgentEvent, { type: "turn_usage" }>;

export interface LoopTokenUsage {
  inputTokensTotal: number;
  inputTokensCacheRead: number;
  outputTokensTotal: number;
}

export const emptyLoopTokenUsage = (): LoopTokenUsage => ({
  inputTokensTotal: 0,
  inputTokensCacheRead: 0,
  outputTokensTotal: 0,
});

/**
 * Accumulate persisted model-turn usage for one agent loop. Only a terminal turn with visible
 * prose produces a chat event; tool-selection turns remain execution-dashboard detail.
 */
export function foldTurnUsageForChat(
  totals: LoopTokenUsage,
  event: TurnUsageEvent,
): { totals: LoopTokenUsage; displayEvent?: TurnUsageEvent } {
  const next = {
    inputTokensTotal: totals.inputTokensTotal + event.inputTokensTotal,
    inputTokensCacheRead: totals.inputTokensCacheRead + event.inputTokensCacheRead,
    outputTokensTotal: totals.outputTokensTotal + event.outputTokensTotal,
  };
  if (event.toolCalls.length > 0 || !event.outputText?.trim()) return { totals: next };
  return {
    totals: next,
    displayEvent: {
      ...event,
      inputTokensTotal: next.inputTokensTotal,
      inputTokensCacheRead: next.inputTokensCacheRead,
      outputTokensTotal: next.outputTokensTotal,
    },
  };
}

// Replaces the open trailing assistant bubble with the accumulated text, or starts one. Used by both the
// streaming and the final flush.
export function upsertAssistantText(messages: Message[], content: string): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant" && !last.thinking) {
    const next = [...messages];
    next[next.length - 1] = { ...last, content };
    return next;
  }
  return [...messages, { role: "assistant", content }];
}

export function upsertReasoningText(messages: Message[], content: string): Message[] {
  const last = messages[messages.length - 1];
  if (last?.role === "reasoning") {
    const next = [...messages];
    next[next.length - 1] = { ...last, content };
    return next;
  }
  return [...messages, { role: "reasoning", content }];
}

// Marks the current assistant turn as "thinking" (so it renders collapsed once a tool runs)
// and appends the live tool-status bubble.
function appendToolStart(messages: Message[], name: string, args: Record<string, unknown>, id?: string): Message[] {
  const last = messages[messages.length - 1];
  const toolMsg: Message = {
    role: "tool_start",
    toolName: name,
    ...(id ? { toolCallId: id } : {}),
    toolSummary: toolArgSummary(name, args),
    toolDone: false,
  };
  if (last?.role === "assistant" && !last.thinking) {
    return [...messages.slice(0, -1), { ...last, thinking: true }, toolMsg];
  }
  return [...messages, toolMsg];
}

// The open bubble an event refers to: matched by tool_call id so parallel calls stay separate, else the
// most recent open bubble for that tool (providers without ids).
function findOpenToolIdx(messages: Message[], name: string, id?: string, unlinkedOnly = false): number {
  for (let j = messages.length - 1; j >= 0; j--) {
    const m = messages[j];
    if (m.role !== "tool_start" || m.toolDone) continue;
    if (id && m.toolCallId) {
      if (m.toolCallId === id) return j;
      continue;
    }
    if (m.toolName !== name) continue;
    // Id-less fallback for a link: an already-linked bubble belongs to a different parallel
    // call, so keep looking rather than overwriting its link.
    if (unlinkedOnly && m.calleeConversationId) continue;
    return j;
  }
  return -1;
}

const linkFields = (link: CallAgentMeta) => ({
  calleeWorkspaceId: link.workspaceId,
  calleeWorkspaceName: link.workspaceName,
  calleeConversationId: link.conversationId,
});

// Flips the tool bubble this result belongs to to done, attaching the callee session link
// if one was provided (call_agent only).
function markToolDone(messages: Message[], name: string, id?: string, link?: CallAgentMeta): Message[] {
  const idx = findOpenToolIdx(messages, name, id);
  if (idx === -1) return messages;
  const next = [...messages];
  next[idx] = { ...next[idx], toolDone: true, ...(link ? linkFields(link) : {}) };
  return next;
}

// Adds the callee session link to a still-open call_agent bubble, so "View session" works while the
// spinner runs. No-op if already linked.
function attachToolLink(messages: Message[], name: string, link: CallAgentMeta, id?: string): Message[] {
  const idx = findOpenToolIdx(messages, name, id, true);
  if (idx === -1 || messages[idx].calleeConversationId === link.conversationId) return messages;
  const next = [...messages];
  next[idx] = { ...next[idx], ...linkFields(link) };
  return next;
}

// Closes every open tool bubble when a turn ends without their results (e.g. the user hit escape), so no
// spinner runs forever. Returns the same array when nothing is open.
export function markAllToolsDone(messages: Message[]): Message[] {
  if (!messages.some((m) => m.role === "tool_start" && !m.toolDone)) return messages;
  return messages.map((m) => (m.role === "tool_start" && !m.toolDone ? { ...m, toolDone: true } : m));
}

// Inserts the loop's total usage badge just before its final output, at `turnStartIndex`.
function insertUsage(
  messages: Message[],
  inputTokensTotal: number,
  inputTokensCacheRead: number,
  outputTokensTotal: number,
  turnStartIndex = messages.length,
): Message[] {
  if (inputTokensTotal === 0 && outputTokensTotal === 0) return messages;
  const index = Math.max(0, Math.min(turnStartIndex, messages.length));
  return [
    ...messages.slice(0, index),
    { role: "usage", inputTokensTotal, inputTokensCacheRead, outputTokensTotal },
    ...messages.slice(index),
  ];
}

// Pure reducer for the non-streaming events (tokens/reasoning are coalesced in the hook).
// Unrecognized events leave the state untouched.
export function applyDiscreteEvent(
  state: TranscriptState,
  event: AgentEvent,
  turnStartIndex?: number,
): TranscriptState {
  switch (event.type) {
    case "tool_start":
      return { ...state, messages: appendToolStart(state.messages, event.name, event.args, event.id) };
    case "tool_link":
      return { ...state, messages: attachToolLink(state.messages, event.name, event.meta, event.id) };
    case "tool_result":
      return {
        ...state,
        messages: markToolDone(
          state.messages,
          event.name,
          event.id,
          event.name === "call_agent" ? event.meta : undefined,
        ),
      };
    case "turn_usage":
      return {
        ...state,
        messages: insertUsage(
          state.messages,
          event.inputTokensTotal,
          event.inputTokensCacheRead,
          event.outputTokensTotal,
          turnStartIndex,
        ),
      };
    case "done":
      return state;
    case "limit_reached":
      return { ...state, messages: [...state.messages, { role: "limit_notice" }] };
    case "error":
      return { ...state, messages: [...state.messages, { role: "error", content: event.message }] };
    default:
      return state;
  }
}

// A lost stream isn't a failed run (the server keeps it going), so it is a notice, not an error. Appending
// is idempotent so reconnect attempts don't stack notices.
export function appendDisconnected(messages: Message[]): Message[] {
  if (messages[messages.length - 1]?.role === "disconnected") return messages;
  return [...messages, { role: "disconnected" }];
}

export function clearDisconnected(messages: Message[]): Message[] {
  return messages.filter((m) => m.role !== "disconnected");
}
