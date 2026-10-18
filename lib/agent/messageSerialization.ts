// Persists the agent's message history and projects it into the chat transcript. The system prompt is
// stripped before saving and rebuilt each run, so a stale one is never frozen.
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
  type StoredMessage,
  type AIMessage,
  type ToolMessage,
} from "@langchain/core/messages";
import type { Message } from "@/lib/transcript/message";
import { toolArgSummary } from "@/lib/transcript/toolDisplay";
import { contentToText } from "@/lib/transcript/content";
import { storedReasoning } from "./reasoningReplay";

function isSystem(m: BaseMessage): boolean {
  return m._getType() === "system";
}

/** Strip the leading system prompt (if present) and serialize the rest to JSON-safe records. */
export function serializeMessages(messages: BaseMessage[]): StoredMessage[] {
  const body = messages.length > 0 && isSystem(messages[0]) ? messages.slice(1) : messages;
  return mapChatMessagesToStoredMessages(body);
}

/** Rebuild LangChain message instances from stored records. No system prompt is included. */
export function deserializeMessages(stored: StoredMessage[]): BaseMessage[] {
  return mapStoredMessagesToChatMessages(stored);
}

/** Sets the system prompt at index 0, replacing one or unshifting without clobbering a real message. */
export function setSystemPrompt(messages: BaseMessage[], system: BaseMessage): void {
  if (messages.length > 0 && isSystem(messages[0])) messages[0] = system;
  else messages.unshift(system);
}

// Stashed on the run's last message, not appended as its own: an extra AIMessage would be replayed
// as something the assistant said. `additional_kwargs` survives serialization and no adapter reads it.
const RUN_ERROR_KEY = "runError";

// Persists why a run stopped; otherwise a reopened conversation shows a prompt apparently ignored. Only
// the text is kept, since the usage ledger already has the error code.
export function noteRunError(messages: BaseMessage[], message: string): void {
  const last = messages.at(-1);
  if (!last) return;
  (last.additional_kwargs as Record<string, unknown>)[RUN_ERROR_KEY] = message;
}

function readRunError(message: BaseMessage): string | null {
  const note = (message.additional_kwargs as Record<string, unknown> | undefined)?.[RUN_ERROR_KEY];
  return typeof note === "string" && note ? note : null;
}

// Usage totals come from the execution ledger, keyed by the final AIMessage's id; the conversation never
// stores its own copy.
export function messagesToTranscript(
  messages: BaseMessage[],
  outputUsage: ReadonlyMap<
    string,
    { inputTokensTotal: number; inputTokensCacheRead: number; outputTokensTotal: number }
  > = new Map(),
): Message[] {
  const out: Message[] = [];
  const bubbleByCallId = new Map<string, number>();

  const appendUsage = (message: AIMessage) => {
    const metadata = message.response_metadata as { executionTurnId?: unknown } | undefined;
    const executionTurnId = typeof metadata?.executionTurnId === "string" ? metadata.executionTurnId : undefined;
    const usage = executionTurnId ? outputUsage.get(executionTurnId) : undefined;
    if (!usage || (usage.inputTokensTotal === 0 && usage.outputTokensTotal === 0)) return;
    out.push({
      role: "usage",
      inputTokensTotal: usage.inputTokensTotal,
      inputTokensCacheRead: usage.inputTokensCacheRead,
      outputTokensTotal: usage.outputTokensTotal,
    });
  };

  for (const m of messages) {
    switch (m._getType()) {
      case "human":
        out.push({ role: "user", content: contentToText(m.content) });
        break;
      case "ai": {
        const ai = m as AIMessage;
        const text = contentToText(ai.content);
        const toolCalls = ai.tool_calls ?? [];
        // Match the live transcript: usage introduces the model output or tool action it measures.
        appendUsage(ai);
        // Reasoning streams ahead of the prose and tool calls it led to, so it is replayed first.
        const reasoning = storedReasoning(ai);
        if (reasoning.trim()) out.push({ role: "reasoning", content: reasoning });
        if (toolCalls.length === 0) {
          if (text.trim()) out.push({ role: "assistant", content: text });
        } else {
          if (text.trim()) out.push({ role: "assistant", content: text, thinking: true });
          for (const tc of toolCalls) {
            const idx =
              out.push({
                role: "tool_start",
                toolName: tc.name,
                toolSummary: toolArgSummary(tc.name, (tc.args ?? {}) as Record<string, unknown>),
                toolDone: true,
              }) - 1;
            if (tc.id) bubbleByCallId.set(tc.id, idx);
          }
        }
        break;
      }
      case "tool": {
        const tm = m as ToolMessage;
        const idx = bubbleByCallId.get(tm.tool_call_id);
        // Mirror the live stream: a call_agent bubble carries a deep-link to the callee's session,
        // not a result body. runner.ts stashed it on the ToolMessage so it survives reload.
        if (idx !== undefined && out[idx].toolName === "call_agent") {
          const kw = tm.additional_kwargs as
            { calleeConversationId?: unknown; calleeWorkspaceId?: unknown; calleeWorkspaceName?: unknown } | undefined;
          if (typeof kw?.calleeConversationId === "string" && typeof kw?.calleeWorkspaceId === "string") {
            out[idx] = {
              ...out[idx],
              calleeConversationId: kw.calleeConversationId,
              calleeWorkspaceId: kw.calleeWorkspaceId,
              ...(typeof kw.calleeWorkspaceName === "string" ? { calleeWorkspaceName: kw.calleeWorkspaceName } : {}),
            };
          }
        }
        break;
      }
      // system messages are not rendered
    }
    const runError = readRunError(m);
    if (runError) out.push({ role: "error", content: runError });
  }
  return out;
}
