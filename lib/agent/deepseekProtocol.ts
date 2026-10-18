// Everything DeepSeek requires that no other provider should inherit. Canonical conversation messages
// stay provider-neutral; this module restores its private reasoning at the outbound boundary.
import { AsyncLocalStorage } from "node:async_hooks";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { ChatOpenAI, type ChatOpenAIFields } from "@langchain/openai";
import { replayReasoning } from "./reasoningReplay";
import { THINKING_OFF_EFFORT, type ReasoningEffort } from "../models/llmSelection";

/** Reasoning for one request, keyed by the tool-call id of the turn that produced it. */
type ReasoningLookup = Map<string, string>;

// Per-call, not per-client: bindTools wraps the shared client in a fresh Runnable, so instance state
// would miss those calls and leak lookups between them.
const REASONING_SCOPE = new AsyncLocalStorage<ReasoningLookup>();

// `reasoning_effort` has no "none", so off is a separate field. Always sent: since 13 Aug 2026 V4
// models default to "high", so silence pays for maximum reasoning.
export function deepseekReasoningConfig(effort: ReasoningEffort): { modelKwargs: Record<string, unknown> } {
  return effort === THINKING_OFF_EFFORT
    ? { modelKwargs: { thinking: { type: "disabled" } } }
    : { modelKwargs: { reasoning_effort: effort } };
}

/** An assistant message as it appears in the request body, once LangChain has converted it. */
type WireMessage = { tool_calls?: Array<{ id?: string }>; reasoning_content?: string };

// Paired by tool-call id, not position, which compaction would shift. An unparseable body passes
// through untouched: replay must never fail a call.
function restoreReasoningContent(body: string, lookup: ReasoningLookup): string {
  let payload: { messages?: WireMessage[] };
  try {
    payload = JSON.parse(body);
  } catch {
    return body;
  }
  if (!Array.isArray(payload.messages)) return body;

  let changed = false;
  for (const message of payload.messages) {
    const id = message.tool_calls?.[0]?.id;
    const reasoning = id ? lookup.get(id) : undefined;
    if (reasoning && message.reasoning_content === undefined) {
      message.reasoning_content = reasoning;
      changed = true;
    }
  }
  return changed ? JSON.stringify(payload) : body;
}

// Injected at fetch because LangChain drops reasoning_content from additional_kwargs. The body here is
// DeepSeek's documented shape, a steadier contract than SDK internals.
function deepseekFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const lookup = REASONING_SCOPE.getStore();
    if (!lookup?.size || typeof init?.body !== "string") return inner(input, init);
    return inner(input, { ...init, body: restoreReasoningContent(init.body, lookup) });
  };
}

/** A ChatOpenAI that replays reasoning, wrapping whatever fetch the caller already installed. */
export function createDeepSeekChatModel(fields: ChatOpenAIFields): ChatOpenAI {
  const inner = (fields.configuration?.fetch as typeof fetch | undefined) ?? fetch;
  return new ChatOpenAI({
    ...fields,
    configuration: { ...fields.configuration, fetch: deepseekFetch(inner) },
  });
}

/** What each turn reasoned, addressed by the tool call that turn made. */
function lookupFrom(messages: BaseMessage[]): ReasoningLookup {
  const lookup: ReasoningLookup = new Map();
  for (const message of messages) {
    if (!(message instanceof AIMessage)) continue;
    const id = message.tool_calls?.[0]?.id;
    const reasoning = replayReasoning(message);
    if (id && reasoning) lookup.set(id, reasoning);
  }
  return lookup;
}

// Runs one call with its reasoning in scope for the fetch above; messages go out untouched. Scoped to
// the call, so nothing leaks into the next.
export function sendWithDeepSeekReasoning<T>(
  messages: BaseMessage[],
  send: (messages: BaseMessage[]) => Promise<T>,
): Promise<T> {
  return REASONING_SCOPE.run(lookupFrom(messages), () => send(messages));
}
