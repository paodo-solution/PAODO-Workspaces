// Everything Scaleway requires that no other provider should inherit: it spells reasoning with a
// different field name than the SDK reads, and it accepts effort levels its models do not honour.
import { ChatOpenAI, ChatOpenAICompletions, type ChatOpenAIFields } from "@langchain/openai";
import type { BaseMessage, BaseMessageChunk } from "@langchain/core/messages";
import { scalewayModel } from "../models/registry";
import type { ReasoningEffort } from "../models/llmSelection";

// An unsupported level becomes the model's default, which Scaleway would silently apply anyway. A model
// missing from the registry gets the level unchanged.
export function scalewayEffort(model: string, effort: ReasoningEffort): ReasoningEffort {
  const spec = scalewayModel(model);
  if (!spec) return effort;
  return spec.efforts.includes(effort) ? effort : spec.fallbackEffort;
}

/** Scaleway's own documented dial. Raw because "none" is not in the SDK's typed effort union. */
export function scalewayReasoningConfig(
  model: string,
  effort: ReasoningEffort,
): { modelKwargs: { reasoning_effort: ReasoningEffort } } {
  return { modelKwargs: { reasoning_effort: scalewayEffort(model, effort) } };
}

// Scaleway sends `reasoning` but the SDK only reads `reasoning_content`, so it would be billed then
// dropped. An existing `reasoning_content` wins.
export function renameScalewayReasoning<T extends object>(payload: T): T {
  const { reasoning, reasoning_content } = payload as ScalewayReasoningFields;
  if (typeof reasoning !== "string" || typeof reasoning_content === "string") return payload;
  return { ...payload, reasoning_content: reasoning };
}

/** The two spellings, as they appear on both a streamed delta and a whole message. */
interface ScalewayReasoningFields {
  reasoning?: unknown;
  reasoning_content?: unknown;
}

// Overrides both the streaming and non-streaming hooks. Scaleway reports no reasoning token count, so
// outputTokensReasoning stays 0; the cost is still in completion_tokens.
class ScalewayCompletions extends ChatOpenAICompletions {
  protected _convertCompletionsDeltaToBaseMessageChunk(
    delta: Record<string, unknown>,
    ...rest: [rawResponse: never, defaultRole?: never]
  ): BaseMessageChunk {
    return super._convertCompletionsDeltaToBaseMessageChunk(renameScalewayReasoning(delta), ...rest);
  }

  protected _convertCompletionsMessageToBaseMessage(
    message: ScalewayReasoningFields & { role: "assistant" },
    ...rest: [rawResponse: never]
  ): BaseMessage {
    // Cast because the base signature names OpenAI's ChatCompletionMessage, a type this repo has no
    // direct dependency on. The rename preserves every field, so the shape reaching super is unchanged.
    const restored = renameScalewayReasoning(message) as typeof message;
    return super._convertCompletionsMessageToBaseMessage(restored as never, ...rest);
  }
}

/** A ChatOpenAI that reads Scaleway's reasoning field, via the same seam as mistralProtocol.ts. */
export function createScalewayChatModel(fields: ChatOpenAIFields): ChatOpenAI {
  return new ChatOpenAI({ ...fields, completions: new ScalewayCompletions(fields) });
}
