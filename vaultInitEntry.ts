// One-shot vault-init job, run by compose before the app, credproxy and llm-proxy start. Exits non-zero,
// stopping the deploy, whenever a vault and its private key are not a usable pair.
import { createLogger, exitAfterLogs } from "./lib/infra/logger";
import { PROVIDER_PRIVATE_KEY_FILE } from "./lib/infra/security/providerKeyPrivateKeyPaths";
import { PROVIDER_VAULT_FILE } from "./lib/infra/security/providerKeyVaultFormat";
import { initProviderKeyVault } from "./lib/infra/security/providerKeyVaultInit";
import { WORKSPACE_SECRET_PRIVATE_KEY_FILE } from "./lib/infra/security/workspaceSecretKeyPaths";
import { WORKSPACE_SECRET_VAULT_FILE } from "./lib/infra/security/workspaceSecretVaultFormat";
import { initWorkspaceSecretVault } from "./lib/infra/security/workspaceSecretVaultInit";

const log = createLogger("vaultInit");

const VAULTS = [
  {
    name: "workspace-secret",
    vaultFile: WORKSPACE_SECRET_VAULT_FILE,
    privateKeyFile: WORKSPACE_SECRET_PRIVATE_KEY_FILE,
    init: initWorkspaceSecretVault,
  },
  { name: "provider", vaultFile: PROVIDER_VAULT_FILE, privateKeyFile: PROVIDER_PRIVATE_KEY_FILE, init: initProviderKeyVault },
];

for (const { name, vaultFile, privateKeyFile, init } of VAULTS) {
  try {
    const outcome = init({ vaultFile, privateKeyFile });
    log.info({ event: "vault_init", vault: name, outcome }, `${name} vault ${outcome}`);
  } catch (err) {
    log.fatal(
      { event: "vault_init_failed", vault: name, outcome: "process_exit", err, filePath: vaultFile },
      `${name} vault could not be initialized — refusing to let the app or the proxies start`,
    );
    exitAfterLogs(1);
  }
}
exitAfterLogs(0);
