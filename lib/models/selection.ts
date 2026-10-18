// Resolves a partial model choice identically for the client picker and the server. Free of the
// registry (it pulls the LLM SDKs): vocabularies arrive as data.
import { NO_DIAL_EFFORT, type ReasoningEffort } from "@/lib/models/llmSelection";

/** What the selected provider offers: its models, and the effort levels each one accepts. */
export interface ModelVocabulary {
  models: readonly string[];
  // Keyed by model id, because effort levels belong to the model and not to its provider. An empty
  // list — or no entry, as for a retired id a workspace still stores — means the model has no dial.
  modelReasoningEfforts: Readonly<Record<string, readonly ReasoningEffort[]>>;
}

const NO_EFFORTS: readonly ReasoningEffort[] = [];

/** The levels one model accepts. Empty when it has no dial or the vocabulary does not list it. */
export function effortsForModel(vocabulary: ModelVocabulary, model: string): readonly ReasoningEffort[] {
  const perModel = vocabulary.modelReasoningEfforts;
  return Object.hasOwn(perModel, model) ? perModel[model] : NO_EFFORTS;
}

/** A complete, usable choice — what the workspace stores and the agent runs with. */
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort: ReasoningEffort;
}

/** A choice as a caller expressed it: any subset, each field independently omittable. */
export interface RequestedModelSelection {
  provider?: string;
  model?: string;
  reasoningEffort?: string;
}

function trimmed(value: string | undefined): string | undefined {
  const result = value?.trim();
  return result ? result : undefined;
}

// The provider's first catalog entry (the catalog lists its default first). Empty when it serves no
// models, which the caller reports rather than storing.
export function defaultModelFor(vocabulary: ModelVocabulary): string {
  return vocabulary.models[0] ?? "";
}

// "low" if offered, else the quietest level other than "none". Never carried over from the previous
// model, whose level the new one might reject.
export function defaultEffortFor(vocabulary: ModelVocabulary, model: string): ReasoningEffort {
  const accepted = effortsForModel(vocabulary, model);
  if (accepted.includes("low")) return "low";
  return accepted.find((effort) => effort !== "none") ?? accepted[0];
}

// First provider, its first model, that model's default effort. `providers` is pre-filtered by
// buildModel.ts; all fields are empty when every provider is off.
export function firstAvailableSelection(
  providers: readonly string[],
  vocabularyFor: (provider: string) => ModelVocabulary,
): ModelSelection {
  const [provider] = providers;
  if (!provider) return { provider: "", model: "", reasoningEffort: NO_DIAL_EFFORT };
  const vocabulary = vocabularyFor(provider);
  const model = defaultModelFor(vocabulary);
  const efforts = effortsForModel(vocabulary, model);
  return {
    provider,
    model,
    // A model with no dial stores the uniform placeholder rather than a level it would reject —
    // defaultEffortFor has nothing to return from an empty list.
    reasoningEffort: efforts.length > 0 ? defaultEffortFor(vocabulary, model) : NO_DIAL_EFFORT,
  };
}

// Per field: omitted ones keep current values, a model change resets effort, an explicit effort wins.
// Doesn't validate; the caller decides whether to refuse a value.
export function resolveModelSelection(
  requested: RequestedModelSelection,
  current: ModelSelection,
  vocabularyFor: (provider: string) => ModelVocabulary,
): ModelSelection {
  const provider = trimmed(requested.provider) ?? current.provider;
  const vocabulary = vocabularyFor(provider);
  const providerChanged = provider !== current.provider;

  // A provider switch retires the previous model and effort alike. On the same provider, a model
  // change keeps that explicit model but resets effort below; an effort-only change keeps the model.
  const model = trimmed(requested.model) ?? (providerChanged ? defaultModelFor(vocabulary) : current.model);
  const modelChanged = model !== current.model;

  if (effortsForModel(vocabulary, model).length === 0) {
    // The stored value is a placeholder the agent never sends. Overwriting it keeps every no-dial
    // model reading the same rather than preserving whatever the last one used.
    return { provider, model, reasoningEffort: NO_DIAL_EFFORT };
  }

  const reasoningEffort =
    (trimmed(requested.reasoningEffort) as ReasoningEffort | undefined) ??
    (providerChanged || modelChanged ? defaultEffortFor(vocabulary, model) : current.reasoningEffort);

  return { provider, model, reasoningEffort };
}
