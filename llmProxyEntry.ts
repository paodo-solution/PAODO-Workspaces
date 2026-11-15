// llm-proxy entry point: the only process that can open provider keys. The app sends model calls here with a
// placeholder key; this adds the real one. Read-only mounts, no workspace data; reloads on vault change.
import * as fs from "fs";
import { createLogger, exitAfterLogs } from "./lib/infra/logger";
import { createLlmProxyServer } from "./lib/infra/llmProxy/llmProxyServer";
import {
  loadProviderPrivateKey,
  providerApiKey,
  rebuildProviderKeyRing,
  reloadProviderKeyRing,
} from "./lib/infra/llmProxy/providerKeyRing";
import { PROVIDER_UPSTREAMS } from "./lib/infra/llmProxy/upstreams";
import { PROVIDER_VAULT_FILE, assertProviderVaultAvailable } from "./lib/infra/security/providerKeyVault";

const log = createLogger("llmProxyEntry");
const LLM_PROXY_PORT = parseInt(process.env.LLM_PROXY_PORT ?? "9997", 10);

function fatal(reason: string, err: unknown): never {
  log.fatal({ event: "process_fatal", outcome: "process_exit", err, reason }, "process exiting after fatal error");
  exitAfterLogs(1);
}

process.on("uncaughtException", (err) => fatal("uncaughtException", err));
process.on("unhandledRejection", (err) => fatal("unhandledRejection", err));

try {
  assertProviderVaultAvailable();
  loadProviderPrivateKey();
} catch (err) {
  log.fatal(
    { event: "startup_provider_vault_unavailable", outcome: "process_exit", err, filePath: PROVIDER_VAULT_FILE },
    "provider vault or its private key could not be read safely — refusing to start llm-proxy",
  );
  exitAfterLogs(1);
}

const loaded = rebuildProviderKeyRing();
const server = createLlmProxyServer({ upstreams: PROVIDER_UPSTREAMS, apiKey: providerApiKey });
server.on("error", (err) => fatal("listener", err));
server.listen(LLM_PROXY_PORT, () => log.info({ port: LLM_PROXY_PORT, keys: loaded }, "llm-proxy ready"));

// watchFile (stat polling) survives atomicSaveJson's temp-then-rename writes, which break an fs.watch inode watch.
// A private key that no longer matches the vault exits, so the restart loads the current pair or stops loudly.
fs.watchFile(PROVIDER_VAULT_FILE, { interval: 1000 }, () => {
  let keys: number;
  try {
    keys = reloadProviderKeyRing();
  } catch (err) {
    fatal("provider private key no longer matches the vault", err);
  }
  log.info({ keys }, "reloaded provider keys after vault change");
});
