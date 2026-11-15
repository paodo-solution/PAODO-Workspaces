// Opens the sealed provider keys for llm-proxy. Needs the private key, which only llm-proxy and vault-init
// mount; the ESLint config bans importing this module from the app.
import { createPrivateKey, type KeyObject } from "crypto";
import { readFileSync } from "fs";
import { createLogger } from "../logger";
import { openWith } from "../security/secretOpen";
import { recipientOf } from "../security/secretSeal";
import {
  assertProviderVaultAvailable,
  providerKeyRecipient,
  providerKeyRecords,
  reloadProviderVault,
} from "../security/providerKeyVault";
import { providerKeyContext } from "../security/providerKeyVaultFormat";
import { PROVIDER_PRIVATE_KEY_FILE } from "../security/providerKeyPrivateKeyPaths";

const log = createLogger("providerKeyRing");

let privateKey: KeyObject | null = null;
const keys = new Map<string, string>();

export function loadProviderPrivateKey(file: string = PROVIDER_PRIVATE_KEY_FILE): void {
  const pem = readFileSync(file, "utf8");
  if (recipientOf(pem) !== providerKeyRecipient()) {
    throw new Error("provider private key does not match the vault's recipient");
  }
  privateKey = createPrivateKey(pem);
}

/** Re-opens every key from the vault records; a key that fails to open is left out and logged. */
export function rebuildProviderKeyRing(): number {
  if (!privateKey) throw new Error("provider private key not loaded — call loadProviderPrivateKey() first");
  keys.clear();
  for (const [provider, entry] of Object.entries(providerKeyRecords())) {
    try {
      keys.set(provider, openWith(entry.sealed, privateKey, providerKeyContext(provider)));
    } catch (err) {
      log.error(
        { event: "provider_key_open_failed", outcome: "provider_key_unavailable", err, provider },
        "a provider key could not be opened — calls to this provider will be refused",
      );
    }
  }
  return keys.size;
}

export function providerApiKey(provider: string): string | undefined {
  return keys.get(provider);
}

// After a vault change: an unreadable vault clears every key (fail closed). A readable one re-reads the private
// key, so a vault-init re-run is picked up; a key that no longer matches throws, and the caller exits.
export function reloadProviderKeyRing(): number {
  reloadProviderVault();
  try {
    assertProviderVaultAvailable();
  } catch {
    keys.clear();
    return 0;
  }
  loadProviderPrivateKey();
  return rebuildProviderKeyRing();
}
