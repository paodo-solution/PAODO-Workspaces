// Internet access and its domain allowlist: the registry, the proxy policy and the sidecar attachment
// (containerManager.ts) must agree, with rollback on failure. Applied to the running container, never recreated.
import type { IWorkspaceStore } from "@/lib/infra/interfaces";
import { getContainers } from "@/lib/infra/services";
import { setInternetAccessPolicy } from "@/lib/infra/proxy/internetAccessPolicy";
import { createLogger } from "@/lib/infra/logger";
import { isValidDomain, normalizeDomain } from "@/lib/workspace/domain";
import type { DomainAllowlist } from "@/lib/workspace/types";
import { WorkspaceUpdateError, WorkspaceUpdateFailure } from "./errors";

export type EgressWriter = Pick<IWorkspaceStore, "setWorkspaceInternetAccess" | "setWorkspaceDomainAllowlist">;

export interface EgressServices {
  setPolicy(id: string, enabled: boolean, allowlist: DomainAllowlist | undefined): void;
  applyToContainer(id: string, enabled: boolean): Promise<void>;
}

export interface EgressResult {
  /** False when the registry refused the write, which past a known-good id means the workspace vanished. */
  applied: boolean;
}

const log = createLogger("workspaceOperations");

function defaultEgressServices(): EgressServices {
  return {
    setPolicy: setInternetAccessPolicy,
    applyToContainer: (id, enabled) => getContainers().applyInternetAccess(id, enabled),
  };
}

export function validateInternetAccess(value: unknown): boolean {
  if (typeof value !== "boolean") throw new WorkspaceUpdateError("internetAccess must be true or false");
  return value;
}

export const MAX_ALLOWED_DOMAINS = 100;

export function validateDomainRestriction(value: unknown): boolean {
  if (typeof value !== "boolean") throw new WorkspaceUpdateError("domainRestriction must be true or false");
  return value;
}

/** Normalized and deduplicated, in the caller's order; the whole list is refused if one entry is. */
export function validateAllowedDomains(value: unknown): string[] {
  if (!Array.isArray(value)) throw new WorkspaceUpdateError("allowedDomains must be a list of domains");
  if (value.length > MAX_ALLOWED_DOMAINS) {
    throw new WorkspaceUpdateError(`allowedDomains takes at most ${MAX_ALLOWED_DOMAINS} domains`);
  }
  const domains: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || !isValidDomain(raw)) {
      throw new WorkspaceUpdateError(
        `allowedDomains: ${JSON.stringify(raw)} is not a public hostname like api.vercel.com (no wildcard or IP)`,
      );
    }
    const domain = normalizeDomain(raw);
    if (!domains.includes(domain)) domains.push(domain);
  }
  return domains;
}

// Registry, proxy policy and network are one boundary: if the proxy or the network rebuild fails, all
// roll back to `previous` and it throws. `allowlist` is the saved one, so re-enabling restores it.
export async function setInternetAccess(
  id: string,
  enabled: boolean,
  previous: boolean,
  allowlist: DomainAllowlist | undefined,
  store: EgressWriter,
  services: EgressServices = defaultEgressServices(),
): Promise<EgressResult> {
  if (!store.setWorkspaceInternetAccess(id, enabled)) return { applied: false };

  try {
    services.setPolicy(id, enabled, allowlist);
  } catch (err) {
    store.setWorkspaceInternetAccess(id, previous);
    log.error(
      { event: "internet_access_toggle_failed", outcome: "rolled_back", err, workspaceId: id },
      "failed to persist internet-access policy — rolled back",
    );
    throw new WorkspaceUpdateFailure("failed to persist internet-access policy");
  }

  try {
    await services.applyToContainer(id, enabled);
  } catch (err) {
    let rollbackError: unknown;
    try {
      // Restore the proxy first. If that write fails, keep the store at the new value rather than
      // knowingly making the two persisted authorities disagree.
      services.setPolicy(id, previous, allowlist);
      if (!store.setWorkspaceInternetAccess(id, previous)) {
        throw new Error("workspace disappeared while rolling back internet access");
      }
    } catch (rollback) {
      rollbackError = rollback;
    }
    // One literal outcome per branch: `outcome` is how the surfaced-log UI groups these records, so
    // the possible values have to be greppable in the source rather than computed here.
    if (rollbackError) {
      log.error(
        {
          event: "internet_access_toggle_stop_failed",
          outcome: "rollback_failed",
          err,
          rollbackError,
          workspaceId: id,
        },
        "failed to rebuild the workspace network while changing internet access",
      );
    } else {
      log.error(
        { event: "internet_access_toggle_stop_failed", outcome: "rolled_back", err, workspaceId: id },
        "failed to rebuild the workspace network while changing internet access",
      );
    }
    throw new WorkspaceUpdateFailure("failed to apply internet-access setting");
  }

  return { applied: true };
}

// Registry then proxy policy; the container is untouched, since the sidecar stays attached either way. A
// failed policy write rolls the registry back to `previous` and throws.
export function setDomainAllowlist(
  id: string,
  next: DomainAllowlist,
  previous: DomainAllowlist,
  internetAccess: boolean,
  store: EgressWriter,
  services: EgressServices = defaultEgressServices(),
): EgressResult {
  if (!store.setWorkspaceDomainAllowlist(id, next)) return { applied: false };
  try {
    services.setPolicy(id, internetAccess, next);
  } catch (err) {
    store.setWorkspaceDomainAllowlist(id, previous);
    log.error(
      { event: "domain_allowlist_update_failed", outcome: "rolled_back", err, workspaceId: id },
      "failed to persist the domain allowlist policy — rolled back",
    );
    throw new WorkspaceUpdateFailure("failed to persist domain allowlist policy");
  }
  return { applied: true };
}
