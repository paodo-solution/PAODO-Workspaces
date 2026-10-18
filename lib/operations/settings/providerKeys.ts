// Operations for provider API keys: validate first, throw AppError, never return a stored value. Only an
// offered provider may be keyed, which is what makes <PROVIDER>_AVAILABLE=false stick.
import { AppError } from "@/lib/errors/appError";
import { availableProviders, providerAvailabilityEnv, SUPPORTED_PROVIDERS } from "@/lib/agent/buildModel";
import {
  deleteProviderKey,
  hasProviderKey,
  listProviderKeyMeta,
  setProviderKey,
} from "@/lib/infra/security/providerKeyStore";

/** A caller error — a provider this deployment does not offer, or a key that is not a key. */
export class ProviderKeyError extends AppError {
  constructor(message: string) {
    super("INVALID_REQUEST", message);
    this.name = "ProviderKeyError";
  }
}

/**
 * One provider's key status. The ONLY shape this layer returns, and it carries no key.
 *
 * `hint` is present only when a key is set. It is the last few characters — enough to tell two of the
 * operator's own keys apart when they are re-checking which account is being billed, and useless to
 * anyone else. It is why this shape is not exposed to the instance CLI token, which sees only the
 * plain `hasKey` boolean published in the model catalog.
 */
export interface ProviderKeyStatus {
  provider: string;
  hasKey: boolean;
  createdAt?: string;
  hint?: string;
}

// Separate messages for an unknown provider and a switched-off one, naming the env var that actually
// governs it.
function assertAvailable(provider: string): void {
  if (availableProviders().includes(provider)) return;
  if (!SUPPORTED_PROVIDERS.includes(provider)) {
    throw new ProviderKeyError(
      `${provider} is not a provider this app supports. Supported: ${SUPPORTED_PROVIDERS.join(", ")}.`,
    );
  }
  throw new ProviderKeyError(
    `${provider} is switched off in this deployment (${providerAvailabilityEnv(provider)}=false in .env), ` +
      `so it cannot be given an API key. Switch it back on first.`,
  );
}

/**
 * Every provider this deployment offers, each with its key status — including the ones with no key.
 *
 * Listing unkeyed providers is the point: the form has to show a row for a provider precisely when
 * there is nothing stored for it, or there would be nowhere to add the first key.
 */
export function listProviderKeys(): ProviderKeyStatus[] {
  const meta = new Map(listProviderKeyMeta().map((entry) => [entry.provider, entry]));
  return availableProviders().map((provider) => {
    const entry = meta.get(provider);
    return entry
      ? { provider, hasKey: true, createdAt: entry.createdAt, hint: entry.hint }
      : { provider, hasKey: false };
  });
}

/**
 * Store a provider's key, replacing any previous one.
 *
 * The only check is that something non-blank was submitted. There is deliberately no format check:
 * vendors change their key prefixes and lengths without warning, and a validator that is confident
 * about the shape is a validator that one day rejects a key which works perfectly well — locking the
 * operator out of their own deployment for a cosmetic reason. Whether a key is good is a question
 * only the provider can answer, and it answers it on the next run (PROVIDER_KEY_INVALID).
 */
export function storeProviderKey(provider: string, apiKey: unknown): ProviderKeyStatus {
  assertAvailable(provider);
  if (typeof apiKey !== "string" || !apiKey.trim()) {
    throw new ProviderKeyError("apiKey must be a non-empty string");
  }
  // Trimmed because pasting from a vendor dashboard routinely brings a trailing newline, and a key
  // that fails only because of invisible whitespace is the least diagnosable failure of all.
  setProviderKey(provider, apiKey.trim());
  const entry = listProviderKeyMeta().find((meta) => meta.provider === provider);
  return { provider, hasKey: true, createdAt: entry?.createdAt, hint: entry?.hint };
}

/**
 * Remove a provider's key. Idempotent: removing one that is not there is a success with `removed`
 * false, not an error — the caller's intent (no key for this provider) already holds.
 */
export function removeProviderKey(provider: string): { provider: string; removed: boolean } {
  assertAvailable(provider);
  return { provider, removed: deleteProviderKey(provider) };
}

/** Whether a provider can authenticate. The coarse bit safe to publish in the model catalog. */
export function providerHasKey(provider: string): boolean {
  return hasProviderKey(provider);
}
