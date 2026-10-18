// Models and effort levels per offered provider, with or without a key, since keys are entered in the
// app and a fresh install would otherwise show an empty picker.
import { availableProviders, vocabularyFor } from "@/lib/agent/buildModel";
import type { ModelVocabulary } from "@/lib/models/selection";
import { providerHasKey } from "@/lib/operations/settings/providerKeys";

export interface ProviderModelCatalog extends ModelVocabulary {
  // Whether the provider can run. Only a boolean: the CLI token reads this catalog and must learn
  // nothing about the key itself.
  hasKey: boolean;
}

export type ModelCatalog = Record<string, ProviderModelCatalog>;

// `hasKey` is injected rather than imported directly so tests can describe a deployment's key state
// as data, instead of writing an encrypted store to disk to assert on a catalog shape.
export function getModelCatalog(
  env: Record<string, string | undefined> = process.env,
  hasKey: (provider: string) => boolean = providerHasKey,
): ModelCatalog {
  return Object.fromEntries(
    availableProviders(env).map((provider) => [provider, { ...vocabularyFor(provider), hasKey: hasKey(provider) }]),
  );
}
