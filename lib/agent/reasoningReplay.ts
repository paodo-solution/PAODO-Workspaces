// A turn's reasoning, kept on the turn for every provider: it is shown again when the conversation
// is reopened, and replayed to the providers that reject a thinking-mode turn without it.
import type { AIMessage } from "@langchain/core/messages";

/** The providers that are sent reasoning back. modelGateway.ts must hold an adapter for each. */
export const REPLAYING_PROVIDERS = ["mistral", "deepseek"] as const;
export type ReplayingProvider = (typeof REPLAYING_PROVIDERS)[number];

// Private keys holding a raw string, never a vendor encoding. The old name stays so saved conversations
// keep reading.
const REPLAY_REASONING_KEY = "replayReasoning";
const REASONING_PROVIDER_KEY = "reasoningProvider";

// Stored in response_metadata, which persists but is never sent to a provider. `provider` records the
// author, so no other model is handed it as its own.
export function withReplayMetadata(
  metadata: Record<string, unknown>,
  reasoning: string,
  provider?: string,
): Record<string, unknown> {
  if (!reasoning) return metadata;
  return { ...metadata, [REPLAY_REASONING_KEY]: reasoning, ...(provider && { [REASONING_PROVIDER_KEY]: provider }) };
}

// Stored reasoning for display, whoever wrote it. Non-strings read as "", which keeps older history safe.
export function storedReasoning(message: AIMessage): string {
  const value = message.response_metadata?.[REPLAY_REASONING_KEY];
  return typeof value === "string" ? value : "";
}

// Reasoning a replaying provider wrote, or unlabelled legacy reasoning (only they stored it then).
// Display-only reasoning such as Claude's never reaches another model.
export function replayReasoning(message: AIMessage): string {
  const author = message.response_metadata?.[REASONING_PROVIDER_KEY];
  const replayable = typeof author !== "string" || (REPLAYING_PROVIDERS as readonly string[]).includes(author);
  return replayable ? storedReasoning(message) : "";
}
