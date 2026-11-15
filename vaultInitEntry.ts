// One-shot vault-init job, run by compose before the app and credproxy start. Exits non-zero, stopping the
// deploy, whenever the workspace-secret vault and its private key are not a usable pair.
import { createLogger, exitAfterLogs } from "./lib/infra/logger";
import { WORKSPACE_SECRET_PRIVATE_KEY_FILE } from "./lib/infra/security/workspaceSecretKeyPaths";
import { WORKSPACE_SECRET_VAULT_FILE } from "./lib/infra/security/workspaceSecretVaultFormat";
import { initWorkspaceSecretVault } from "./lib/infra/security/workspaceSecretVaultInit";

const log = createLogger("vaultInit");

try {
  const outcome = initWorkspaceSecretVault({
    vaultFile: WORKSPACE_SECRET_VAULT_FILE,
    privateKeyFile: WORKSPACE_SECRET_PRIVATE_KEY_FILE,
  });
  log.info({ event: "workspace_secret_vault_init", outcome }, `workspace-secret vault ${outcome}`);
  exitAfterLogs(0);
} catch (err) {
  log.fatal(
    {
      event: "workspace_secret_vault_init_failed",
      outcome: "process_exit",
      err,
      filePath: WORKSPACE_SECRET_VAULT_FILE,
    },
    "workspace-secret vault could not be initialized — refusing to let the app or the proxy start",
  );
  exitAfterLogs(1);
}
