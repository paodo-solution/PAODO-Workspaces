// Credential-proxy only: opens each sealed secret and groups its proxy token by domain. A value that will not
// open (wrong key, tampered, or moved to another workspace, name or domain) is logged and skipped.
import { readFileSync } from "fs";
import { createPrivateKey, type KeyObject } from "crypto";
import { createLogger } from "../logger";
import { openSealed } from "../security/secretOpen";
import { recipientOf } from "../security/secretSeal";
import { WORKSPACE_SECRET_PRIVATE_KEY_FILE } from "../security/workspaceSecretKeyPaths";
import { proxyToken, type DomainRule } from "../security/workspaceSecretStore";
import { workspaceSecretRecipient, workspaceSecretRecords } from "../security/workspaceSecretVault";

const log = createLogger("workspaceSecretRules");

let privateKey: KeyObject | null = null;

/** Loads the private key and checks it is the one the vault seals to; the proxy refuses to start otherwise. */
export function loadSecretPrivateKey(file: string = WORKSPACE_SECRET_PRIVATE_KEY_FILE): void {
  const pem = readFileSync(file, "utf8");
  if (recipientOf(pem) !== workspaceSecretRecipient()) {
    throw new Error("workspace-secret private key does not match the vault's recipient");
  }
  privateKey = createPrivateKey(pem);
}

// Secrets without a domain are omitted: the proxy has no way to deliver them, so they must never widen
// what gets MITM'd.
export function getWorkspaceRules(wsId: string): DomainRule[] {
  if (!privateKey) throw new Error("workspace-secret private key not loaded — call loadSecretPrivateKey() first");
  const byDomain = new Map<string, Map<string, string>>();
  for (const [name, entry] of Object.entries(workspaceSecretRecords()[wsId] ?? {})) {
    let value: string;
    try {
      value = openSealed(entry.sealed, privateKey, { wsId, name, domains: entry.domains });
    } catch (err) {
      log.error(
        { event: "workspace_secret_open_failed", outcome: "secret_not_injected", err, wsId, name },
        "a workspace secret could not be opened — it will not be injected",
      );
      continue;
    }
    for (const domain of entry.domains) {
      if (!domain) continue;
      let tokenMap = byDomain.get(domain);
      if (!tokenMap) {
        tokenMap = new Map();
        byDomain.set(domain, tokenMap);
      }
      tokenMap.set(proxyToken(wsId, name), value);
    }
  }
  return [...byDomain].map(([domain, tokenMap]) => ({ domain, tokenMap }));
}
