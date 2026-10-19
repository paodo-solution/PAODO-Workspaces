// Third-party secrets the credential proxy injects. Listing and storing share one rule: a scoped secret is
// inert without egress or with every host off the allowlist (`blockedBy`). The workspace's own API/MCP channels are separate (workspaceAccess).
import { getStore } from "@/lib/infra/services";
import {
  deleteSecret,
  listSecretMeta,
  setSecret,
  RESERVED_SECRET_NAMES,
} from "@/lib/infra/security/workspaceSecretStore";
import { enforcedDomains, isValidDomain } from "@/lib/workspace/domain";
import { WorkspaceUpdateError, WorkspaceUpdateFailure } from "./errors";
import type { WorkspaceLookup } from "./read";
import type { Workspace } from "@/lib/workspace/types";

// Exported so callers that publish an input contract (the CLI's schema) state the same rule this
// validates, instead of a copy that drifts.
export const SECRET_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

// Re-exported so the CLI schema states the same rule; defined in the store, which enforces it at injection.
export { RESERVED_SECRET_NAMES };

// A secret's name, date and allowed domains. Never its value, which only the credential proxy injects.
export interface ThirdPartySecret {
  name: string;
  createdAt: string;
  /** Hosts this credential is scoped to. Independent of `internetAccess`: both must allow the call. */
  domains: string[];
  // Set only when something stops the secret working (no egress, or none of its hosts allowed), so no
  // caller mistakes a dormant secret for a live one.
  blockedBy?: SecretBlocker;
}

/** A secret as a caller supplies it. The value is write-only and never read back out of this layer. */
export interface WorkspaceSecretInput {
  name: string;
  value: string;
  domains: string[];
}

/** The raw per-secret metadata the store hands back, before this module derives `blockedBy` from it. */
type SecretMeta = ReturnType<typeof listSecretMeta>[number];

/** Persistence for a secret. Writing the store is the whole job — the proxy sidecar watches that file. */
export interface SecretStore {
  save(id: string, name: string, value: string, domains: string[]): Omit<ThirdPartySecret, "blockedBy">;
  read(id: string): SecretMeta[];
}

export interface SecretDeleter {
  delete(id: string, name: string): boolean;
}

type SecretBlocker = "internetAccess" | "domainAllowlist";

// A missing workspace reads as no egress. Spread in, so the key is absent when nothing blocks.
function blockedFor(workspace: Workspace | undefined, domains: string[]): { blockedBy?: SecretBlocker } {
  if (!workspace?.internetAccess) return { blockedBy: "internetAccess" };
  const allowed = enforcedDomains(workspace.domainAllowlist);
  if (allowed && !domains.some((d) => allowed.includes(d))) {
    return { blockedBy: "domainAllowlist" };
  }
  return {};
}

function defaultSecretStore(): SecretStore & SecretDeleter {
  return {
    save: (id, name, value, domains) => {
      setSecret(id, name, value, domains);
      const saved = listSecretMeta(id).find((item) => item.name === name);
      if (!saved) throw new WorkspaceUpdateFailure("failed to store third-party secret");
      return saved;
    },
    delete: deleteSecret,
    read: listSecretMeta,
  };
}

/** Deletes a third-party secret. The proxy sidecar drops its spend rules when it sees the store change. */
export function deleteWorkspaceSecret(
  id: string,
  name: string,
  store: WorkspaceLookup = getStore(),
  secrets: SecretDeleter = defaultSecretStore(),
): boolean | null {
  if (!store.getWorkspace(id)) return null;
  return secrets.delete(id, name);
}

// Pure; hosts compared normalized. Takes `unknown` since the object comes straight off the wire, and
// every rejection is a WorkspaceUpdateError, never a TypeError 500.
export function validateSecret(input: unknown): WorkspaceSecretInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new WorkspaceUpdateError("secret must be an object with name, value and domains");
  }
  const { name, value, domains } = input as Partial<Record<keyof WorkspaceSecretInput, unknown>>;

  // Type checked first, so a missing and a wrong-typed field get the same message naming the accepted form.
  if (typeof name !== "string" || !SECRET_NAME_RE.test(name)) {
    throw new WorkspaceUpdateError("name must be uppercase letters, digits, and underscores (e.g. OPENAI_KEY)");
  }
  if (RESERVED_SECRET_NAMES.has(name)) {
    throw new WorkspaceUpdateError(`${name} is used by the workspace container itself — choose another name`);
  }
  if (typeof value !== "string" || !value.trim()) throw new WorkspaceUpdateError("value required");
  if (!Array.isArray(domains) || domains.length === 0) {
    throw new WorkspaceUpdateError("add at least one allowed domain");
  }
  for (const raw of domains) {
    if (typeof raw !== "string" || !isValidDomain(raw)) {
      throw new WorkspaceUpdateError("each allowed domain must be a hostname the key is sent to (e.g. api.openai.com)");
    }
  }
  return { name, value, domains };
}

// Listed even without egress (unlike the home page), since they still exist; `blockedBy` marks the
// unspendable ones.
export function listWorkspaceSecrets(
  id: string,
  store: WorkspaceLookup = getStore(),
  secrets: Pick<SecretStore, "read"> = defaultSecretStore(),
): ThirdPartySecret[] {
  const workspace = store.getWorkspace(id);
  if (!workspace) return [];
  return secrets
    .read(id)
    .map(({ name, createdAt, domains }) => ({ name, createdAt, domains, ...blockedFor(workspace, domains) }));
}

// Expects validateSecret's output. Returns the list shape, `blockedBy` included, so the caller learns
// at once if it can't be spent yet.
export function storeWorkspaceSecret(
  id: string,
  input: WorkspaceSecretInput,
  store: WorkspaceLookup = getStore(),
  secrets: SecretStore = defaultSecretStore(),
): ThirdPartySecret {
  const saved = secrets.save(id, input.name, input.value, input.domains);
  // Read egress back after the write rather than before: a workspace that vanished mid-update reads
  // as blocked, which is the truthful answer for a secret that can no longer be spent at all.
  return { ...saved, ...blockedFor(store.getWorkspace(id), saved.domains) };
}
