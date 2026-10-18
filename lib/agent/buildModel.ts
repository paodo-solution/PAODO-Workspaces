// The provider registry: what each provider accepts, which .env var offers it, and how to build its
// client. Server-only; vendor objects never leave here, and keys come from providerKeyStore, not .env.

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { createDeepSeekChatModel, deepseekReasoningConfig } from "./deepseekProtocol";
import type { LLMProviderConfig } from "./interfaces";
import { createModelGateway, type ModelCallObserver, type ModelGateway } from "./modelGateway";
import { createMistralChatModel, mistralRequestConfig } from "./mistralProtocol";
import { providerPacer } from "./rateLimit/providerPacer";
import { parseRateLimitHeaders } from "./rateLimit/rateLimitHeaders";
import { createScalewayChatModel, scalewayReasoningConfig } from "./scalewayProtocol";
import { THINKING_OFF_EFFORT, type ReasoningEffort } from "../models/llmSelection";
import { anthropicModel, listModels, modelEffortLists } from "../models/registry";
import {
  effortsForModel,
  firstAvailableSelection,
  type ModelSelection,
  type ModelVocabulary,
} from "../models/selection";

// Legacy extended-thinking budgets, keyed by the workspace's reasoning-effort knob. Used only for
// a model whose record (lib/models/registry.ts) says it still takes the budget shape.
const ANTHROPIC_THINKING_BUDGET: Partial<Record<ReasoningEffort, number>> = {
  low: 4_000,
  medium: 10_000,
  high: 20_000,
  xhigh: 32_000,
  max: 48_000,
};

// Anthropic's recommended cap for streaming requests, within every offered model's output limit
// and above the largest legacy thinking budget. Thinking is billed against it.
const ANTHROPIC_MAX_OUTPUT_TOKENS = 64_000;

// An Anthropic model's thinking fields, shaped by its record. An id with no record, a future one
// included, takes adaptive thinking: that is what current models require.
export function anthropicThinkingConfig(model: string, effort: ReasoningEffort) {
  const spec = anthropicModel(model);
  if (effort === THINKING_OFF_EFFORT) {
    // No effort goes with it: both off shapes are refused above "high", and every default sits below.
    // The cast is because the SDK's types predate "between_tools"; the object is forwarded verbatim.
    return { thinking: { type: spec?.thinkingOff ?? "disabled" } as { type: "disabled" } };
  }
  if (spec?.thinking === "budget") {
    return { thinking: { type: "enabled" as const, budget_tokens: ANTHROPIC_THINKING_BUDGET[effort] ?? 10_000 } };
  }
  return {
    // Summaries are asked for because adaptive models return thinking blocks empty by default, and
    // the newest ones put their notes between tool calls there. Billing is the same either way.
    thinking: { type: "adaptive" as const, display: "summarized" as const },
    // Anthropic effort accepts low…max: "none" returned above, and "minimal" is on no Anthropic
    // model's list, so validation rejects it upstream.
    outputConfig: { effort: effort as Exclude<ReasoningEffort, "none" | "minimal"> },
  };
}

// The capability half of a provider entry — the only part callers outside this module see.
interface ProviderMetadata {
  supportsPromptCaching: boolean;
}

interface ProviderDescriptor extends ProviderMetadata {
  // The provider's only .env contract: its on/off switch. Keys live in providerKeyStore, not .env, so a
  // deployment can be handed over without them. Spelled out so the var is greppable.
  availabilityEnv: string;
  build: (config: LLMProviderConfig, context: ModelBuildContext) => ChatOpenAI | ChatAnthropic;
}

/** Per-run information providers may translate into their own request fields. */
export interface ModelBuildContext {
  /** Stable for one persisted conversation; contains no prompt content or credentials. */
  cacheScopeId?: string;
}

// Retries belong to us, not the SDK. Left alone, LangChain's AsyncCaller silently retries 6 times
// with backoff, hiding the refusals the gateway has to pace around. Every build spreads this.
const NO_SDK_RETRY = { maxRetries: 0 } as const;

// Feeds every response's rate-limit headers to the pacer, since LangChain hides them on streaming
// calls. Reads headers only, so the body still streams untouched.
function pacedFetch(provider: string, model: string) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await fetch(input as RequestInfo, init);
    try {
      providerPacer.settle({ provider, model }, parseRateLimitHeaders(response.headers));
    } catch {
      // Accounting must never be the reason a model call fails.
    }
    return response;
  };
}

// The single source of truth for provider support. Adding one means an entry here, its models in
// lib/models/registry.ts, and its <PROVIDER>_AVAILABLE=true in the .env of every deployment offering it.
const PROVIDERS: Record<string, ProviderDescriptor> = {
  anthropic: {
    availabilityEnv: "ANTHROPIC_AVAILABLE",
    supportsPromptCaching: true,
    build: (config) =>
      new ChatAnthropic({
        model: config.model,
        apiKey: config.apiKey,
        maxTokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
        // invoke() streams too: the SDK refuses a non-streaming request with a cap this high, and
        // compaction is the one caller that would otherwise send one.
        streaming: true,
        ...NO_SDK_RETRY,
        ...anthropicThinkingConfig(config.model, config.reasoningEffort),
        clientOptions: {
          fetch: pacedFetch("anthropic", config.model),
          ...(config.anthropicCacheTtl1h && {
            defaultHeaders: { "anthropic-beta": "prompt-caching-scope-2026-01-05" },
          }),
        },
      }),
  },
  openai: {
    availabilityEnv: "OPENAI_AVAILABLE",
    supportsPromptCaching: false,
    build: (config) => {
      // "none" disables reasoning, so the summary request is omitted — there would be nothing to
      // summarize. Only a save checks the level against the model; a stored one is sent as is.
      const effort = config.reasoningEffort;
      return new ChatOpenAI({
        model: config.model,
        // `apiKey`, not the legacy `openAIApiKey` alias — the latter is silently ignored by
        // @langchain/openai v1, which then falls back to process.env.OPENAI_API_KEY on its own.
        apiKey: config.apiKey,
        ...NO_SDK_RETRY,
        useResponsesApi: true,
        reasoning: effort === "none" ? { effort } : { effort, summary: "auto" },
        configuration: { fetch: pacedFetch("openai", config.model) },
      });
    },
  },
  deepseek: {
    availabilityEnv: "DEEPSEEK_AVAILABLE",
    supportsPromptCaching: false,
    build: (config) =>
      createDeepSeekChatModel({
        model: config.model,
        ...NO_SDK_RETRY,
        configuration: {
          baseURL: "https://api.deepseek.com/v1",
          apiKey: config.apiKey,
          fetch: pacedFetch("deepseek", config.model),
        },
        ...deepseekReasoningConfig(config.reasoningEffort),
      }),
  },
  moonshot: {
    availabilityEnv: "MOONSHOT_AVAILABLE",
    supportsPromptCaching: false,
    build: (config) =>
      new ChatOpenAI({
        model: config.model,
        ...NO_SDK_RETRY,
        configuration: {
          baseURL: "https://api.moonshot.ai/v1",
          apiKey: config.apiKey,
          fetch: pacedFetch("moonshot", config.model),
        },
        // modelKwargs, not the typed `reasoning`: the SDK sends that only for ids it knows as OpenAI
        // reasoning models, so Kimi's would be dropped. modelKwargs is spread verbatim into the body.
        modelKwargs: { reasoning_effort: config.reasoningEffort },
      }),
  },
  mistral: {
    availabilityEnv: "MISTRAL_AVAILABLE",
    // This flag controls Anthropic-style cache_control markers; Mistral does not use those markers.
    supportsPromptCaching: false,
    build: (config, context) =>
      createMistralChatModel({
        model: config.model,
        ...NO_SDK_RETRY,
        configuration: {
          baseURL: "https://api.mistral.ai/v1",
          apiKey: config.apiKey,
          fetch: pacedFetch("mistral", config.model),
        },
        ...mistralRequestConfig(config.reasoningEffort, context.cacheScopeId),
      }),
  },
  // EU-sovereign inference: open-weight models served from Paris under GDPR, with a zero-retention
  // default and no CLOUD Act exposure. Some are models another provider here also serves directly.
  scaleway: {
    availabilityEnv: "SCALEWAY_AVAILABLE",
    supportsPromptCaching: false,
    build: (config) =>
      createScalewayChatModel({
        model: config.model,
        ...NO_SDK_RETRY,
        configuration: {
          baseURL: "https://api.scaleway.ai/v1",
          apiKey: config.apiKey,
          fetch: pacedFetch("scaleway", config.model),
        },
        ...scalewayReasoningConfig(config.model, config.reasoningEffort),
      }),
  },
};

// The bare vendor client. Runtime code must call buildModel instead, or the call goes unmeasured;
// exported only so tests can assert the SDK wiring.
export function buildChatModel(config: LLMProviderConfig, context: ModelBuildContext = {}): ChatOpenAI | ChatAnthropic {
  const descriptor = PROVIDERS[config.provider];
  // Unknown providers fail loudly here rather than silently resolving to another vendor's builder:
  // the API validates provider on write, so reaching this means a retired provider is still stored.
  if (!descriptor) {
    throw new Error(`unsupported LLM provider "${config.provider}" (supported: ${SUPPORTED_PROVIDERS.join(", ")})`);
  }
  if (!config.model) throw new Error(`no model selected for provider "${config.provider}"`);
  return descriptor.build(config, context);
}

// The model for one run. Callers only ever get the gateway, so no provider or call site can bypass
// what holds for every model call.
export function buildModel(
  config: LLMProviderConfig,
  options: { observe?: ModelCallObserver; cacheScopeId?: string } = {},
): ModelGateway {
  const context: ModelBuildContext = {
    ...(options.cacheScopeId ? { cacheScopeId: options.cacheScopeId } : {}),
  };
  return createModelGateway(buildChatModel(config, context), {
    provider: config.provider,
    model: config.model,
    ...(options.observe ? { observe: options.observe } : {}),
  });
}

// The providers the app supports — the source of truth for the UI provider picker and the API-side
// validation of a workspace's stored provider. Derived from the registry so it can't drift.
export const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS);

// Opt-in: only "true" enables a provider, so a newly added one can't arm spending on a deployment.
// Reads the var in either case, since .env files are written both ways.
function providerAvailable(availabilityEnv: string, env: Record<string, string | undefined>): boolean {
  const raw = env[availabilityEnv] ?? env[availabilityEnv.toLowerCase()];
  return raw?.trim().toLowerCase() === "true";
}

// The providers this deployment offers: every supported one .env names, key or not (that is
// `hasProviderKey`). Drives the picker, GET /api/models, and which providers may hold a key at all.
export function availableProviders(env: Record<string, string | undefined> = process.env): string[] {
  return Object.entries(PROVIDERS)
    .filter(([, { availabilityEnv }]) => providerAvailable(availabilityEnv, env))
    .map(([provider]) => provider);
}

// A provider's models and effort levels. Shared by validateMetadata, GET /api/models and the picker so
// all three agree.
export function vocabularyFor(provider: string): ModelVocabulary {
  return {
    models: listModels(provider),
    modelReasoningEfforts: modelEffortLists(provider),
  };
}

/** The levels one model accepts. Empty for a model with no dial, or one its provider does not offer. */
export function modelReasoningEfforts(provider: string, model: string): readonly ReasoningEffort[] {
  return effortsForModel(vocabularyFor(provider), model);
}

// The first available model in registry order, for a workspace that never picked one. It may lack a
// key on purpose: the picker shows a real choice before any key is entered.
export function defaultModelSelection(env: Record<string, string | undefined> = process.env): ModelSelection {
  return firstAvailableSelection(availableProviders(env), vocabularyFor);
}

// The env var switching a provider off. Exported so env-clearing tests enumerate the contract from
// the registry, not a hand-written list that quietly stops covering the newest provider.
export function providerAvailabilityEnv(provider: string): string | undefined {
  return PROVIDERS[provider]?.availabilityEnv;
}

// Total for legacy stored selections and validation paths that inspect metadata before rejecting an
// unknown provider. Unknown ids have no capabilities; they must never inherit another provider's.
export function getProviderMetadata(provider: string): ProviderMetadata {
  return PROVIDERS[provider] ?? { supportsPromptCaching: false };
}
