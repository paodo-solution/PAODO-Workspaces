/**
 * How a partial model choice becomes a complete one. Owned in one place because the picker resolves
 * it client-side and the update path server-side, and both must give the same answer.
 *
 * Kept free of the provider registry, which pulls the LLM SDKs: the selected provider's vocabulary
 * arrives as data — from the registry on the server, from GET /api/models on the client.
 */
import { NO_DIAL_EFFORT, type ReasoningEffort } from "@/lib/models/llmSelection";

/** What the selected provider offers: its models, and the effort levels each one accepts. */
export interface ModelVocabulary {
  models: readonly string[];
  /**
   * Keyed by model id, because effort levels belong to the model and not to its provider. An empty
   * list — or no entry, as for a retired id a workspace still stores — means the model has no dial.
   */
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

/**
 * The model to select when the caller named none and the previous one no longer applies: the
 * provider's first catalog entry, which the catalog orders default-first — usually the flagship, but
 * deepseek leads with the cheaper Flash on purpose (see registry.ts). Empty when the provider
 * serves no models, which the caller reports rather than storing.
 */
export function defaultModelFor(vocabulary: ModelVocabulary): string {
  return vocabulary.models[0] ?? "";
}

/**
 * The effort to start a model at. Deliberately not the level the previous model was on: the lists
 * only partly overlap, so carrying a level across would sometimes produce a selection the new model
 * rejects at call time — a failure far from the change that caused it. A known-good level every time
 * is worth more than preserving a choice the caller can always restate.
 *
 * "low" whenever offered. The fallback is the quietest level the model does offer rather than its
 * first: `none` disables reasoning outright, so position alone is not a safe rule.
 */
export function defaultEffortFor(vocabulary: ModelVocabulary, model: string): ReasoningEffort {
  const accepted = effortsForModel(vocabulary, model);
  if (accepted.includes("low")) return "low";
  return accepted.find((effort) => effort !== "none") ?? accepted[0];
}

/**
 * The selection a workspace that has never picked one runs and displays: the first available
 * provider, its first model, that model's default effort.
 *
 * `providers` comes filtered and ordered by lib/agent/buildModel.ts, keeping the LLM SDKs out of this
 * client-safe module. All fields are empty when every provider is off, which the app must render.
 */
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

/**
 * Completes a partial model choice against the current selection and the chosen provider's vocabulary.
 *
 * Resolution is per field, so any subset works. An omitted provider keeps the current one. An omitted
 * model and an omitted effort both keep their current value while the provider is unchanged, except a
 * model change resets effort to that model's default. An explicit effort always wins. A model with no
 * effort dial always resolves to the stored placeholder.
 *
 * Validation is NOT done here: this decides what was meant, not whether it is allowed. The caller
 * checks the provider against its registry and the effort against `vocabulary` — it owns the error
 * messages, and only it knows whether an unacceptable value should be refused or coerced. An effort
 * supplied to a no-dial model is one of those refusals, and validateMetadata raises on it; this
 * function only reports the placeholder it resolved to.
 */
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
