// Per-workspace secret vault (its own key, separate from provider keys). The API returns metadata only; the
// container gets opaque proxy tokens, swapped for real values on outbound HTTPS.
import { createHash } from "crypto";
import { createAuditLogger } from "../logger";
import {
  WORKSPACE_SECRET_VAULT_FILE,
  assertWorkspaceSecretVaultAvailable,
  commitWorkspaceSecrets,
  reloadWorkspaceSecretVault,
  workspaceSecretRecords,
  type VaultWorkspaceSecretEntry,
  type VaultWorkspaceSecrets,
} from "./workspaceSecretVault";

const audit = createAuditLogger("secretStore");

// Exposed so the credential-proxy sidecar (a separate process) can watch it for changes.
export const SECRET_STORE_FILE = WORKSPACE_SECRET_VAULT_FILE;

type SecretEntry = VaultWorkspaceSecretEntry;
type Store = VaultWorkspaceSecrets;

// A domain and the tokens the proxy may inject on requests to that domain.
export interface DomainRule {
  domain: string;
  tokenMap: Map<string, string>;
}

// Reduce user input to a bare hostname: strip scheme, path, port, and trailing dot.
export function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

const store: Store = workspaceSecretRecords();

// Production startup calls this before accepting requests to prevent an empty fallback from
// overwriting an existing store that could not be read or decrypted.
export function assertSecretStoreAvailable(): void {
  assertWorkspaceSecretVaultAvailable();
}

function sanitizeDomains(domains: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of domains) {
    const normalized = normalizeDomain(raw ?? "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out.sort();
}

function save(next: Store, context: { operation: string; wsId?: string; name?: string }): void {
  commitWorkspaceSecrets(next, context);
}

// `p` + SHA-256 hex: alphanumeric so CLIs that validate tokens locally accept it. Not a secret: injection
// also needs the workspace's proxy credential and the exact host.
export const PROXY_TOKEN_FORMAT_VERSION = "v2";

export function proxyToken(wsId: string, name: string): string {
  const digest = createHash("sha256").update(`${PROXY_TOKEN_FORMAT_VERSION}\0${wsId}\0${name}`).digest("hex");
  return `p${digest}`;
}

// Names a secret can't use: exec `-e` outranks the container env, so they'd replace proxy, CA or shell
// wiring. validateSecret and buildExecEnv both enforce it; GH_TOKEN is allowed on purpose.
export const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set([
  // Credential-proxy routing and trust (buildRunEnv).
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "SSL_CERT_FILE",
  "GIT_SSL_CAINFO",
  // Shell and loader footing (Dockerfile.workspace).
  "PATH",
  "HOME",
  "BASH_ENV",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NVM_DIR",
  "PYENV_ROOT",
  // Routes Node's fetch/http(s) through the credential proxy (buildExecEnv).
  "NODE_USE_ENV_PROXY",
]);

export function setSecret(wsId: string, name: string, value: string, domains: string[]): void {
  const next = structuredClone(store);
  if (!next[wsId]) next[wsId] = {};
  const sanitized = sanitizeDomains(domains);
  next[wsId][name] = { value, createdAt: new Date().toISOString(), domains: sanitized } satisfies SecretEntry;
  save(next, { operation: "set_secret", wsId, name });
  audit.info({ wsId, name, event: "workspace_secret_set" }, "secret set");
}

export function deleteSecret(wsId: string, name: string): boolean {
  if (!store[wsId]?.[name]) return false;
  const next = structuredClone(store);
  delete next[wsId][name];
  if (Object.keys(next[wsId]).length === 0) delete next[wsId];
  save(next, { operation: "delete_secret", wsId, name });
  audit.info({ wsId, name, event: "workspace_secret_deleted" }, "secret deleted");
  return true;
}

export function listSecretMeta(wsId: string): { name: string; createdAt: string; domains: string[] }[] {
  const ws = store[wsId] ?? {};
  return Object.entries(ws).map(([name, e]) => ({ name, createdAt: e.createdAt, domains: e.domains }));
}

// Picks the github.com-scoped secret to inject as GH_TOKEN (keyed by domain, not name). Tiebreak: GITHUB_TOKEN,
// GH_TOKEN, any GITHUB/GH name, then the first; null if none.
export function selectGithubTokenSecret(metas: { name: string; domains: string[] }[]): string | null {
  const candidates = metas.filter((m) => m.domains.includes("github.com")).map((m) => m.name);
  if (candidates.length === 0) return null;
  return (
    candidates.find((n) => n === "GITHUB_TOKEN") ??
    candidates.find((n) => n === "GH_TOKEN") ??
    // Token-style boundary match (GH_TOKEN, MY_GITHUB_PAT) — not incidental substrings (HIGH_SCORE).
    candidates.find((n) => /(^|_)(GITHUB|GH)(_|$)/.test(n)) ??
    candidates[0]
  );
}

// Returns the proxy rules for a workspace, grouped by domain. Secrets without a domain are
// omitted — the proxy has no way to deliver them, so they must never widen what gets MITM'd.
export function getWorkspaceRules(wsId: string): DomainRule[] {
  const ws = store[wsId] ?? {};
  const byDomain = new Map<string, Map<string, string>>();
  for (const [name, entry] of Object.entries(ws)) {
    for (const domain of entry.domains) {
      if (!domain) continue;
      let tokenMap = byDomain.get(domain);
      if (!tokenMap) {
        tokenMap = new Map();
        byDomain.set(domain, tokenMap);
      }
      tokenMap.set(proxyToken(wsId, name), entry.value);
    }
  }
  return [...byDomain].map(([domain, tokenMap]) => ({ domain, tokenMap }));
}

export function deleteAllForWorkspace(wsId: string): void {
  if (!store[wsId]) return;
  const next = structuredClone(store);
  delete next[wsId];
  save(next, { operation: "delete_workspace_secrets", wsId });
  audit.info({ wsId, event: "workspace_secrets_deleted" }, "all secrets deleted for workspace");
}

// Workspace ids that currently have any secret. Used by the credential-proxy sidecar to know
// which workspaces to (re)compute rules for after a reload.
export function listSecretWorkspaceIds(): string[] {
  return Object.keys(store);
}

// The sidecar reloads on file change; an unreadable vault clears every rule (fails closed).
export function reloadSecretStore(): void {
  reloadWorkspaceSecretVault();
}
