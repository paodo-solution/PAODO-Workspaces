// Loads and changes a workspace's internet access and domain allowlist. A failed read is an `error`, never
// "off"; every change is optimistic and rolls back on rejection. Shared by InternetAccessBlock and EnvVarsBlock.
"use client";

import { useState, useCallback, useMemo } from "react";
import { confirmedValues } from "@/lib/client/workspaceReceipt";
import { fetchJson } from "@/lib/client/fetchJson";
import { useAsyncResource } from "./useAsyncResource";

interface Access {
  enabled: boolean;
  domainRestriction: boolean;
  allowedDomains: string[];
}

const NO_ACCESS: Access = { enabled: false, domainRestriction: false, allowedDomains: [] };

export function useWorkspaceInternetAccess(workspaceId: string | null) {
  const resource = useAsyncResource<Access>(
    useCallback(
      (signal) =>
        fetchJson<Access>(`/api/workspaces/${workspaceId}/internet-access`, signal, "Failed to load internet access."),
      [workspaceId],
    ),
    { enabled: workspaceId !== null },
  );

  // Tagged with both the workspace and the load it was made against (resource.data identity), so a
  // reload of the server value supersedes a stale local edit instead of masking it.
  const [override, setOverride] = useState<{ id: string; access: Access; source: Access | null } | null>(null);
  const access = useMemo<Access>(
    () =>
      override && override.id === workspaceId && override.source === resource.data
        ? override.access
        : { ...NO_ACCESS, ...resource.data },
    [override, workspaceId, resource.data],
  );

  // Optimistic: the change renders immediately and is rolled back if the PATCH fails, so a rejected
  // save never leaves the UI showing a state the server didn't keep.
  const change = useCallback(
    async (changes: Partial<Access>) => {
      if (!workspaceId) return;
      const before = access;
      const next = { ...access, ...changes };
      setOverride({ id: workspaceId, access: next, source: resource.data });
      const res = await fetch(`/api/workspaces/${workspaceId}/internet-access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      if (!res.ok) {
        setOverride({ id: workspaceId, access: before, source: resource.data });
        return;
      }
      const confirmed = await confirmedValues(res);
      setOverride({
        id: workspaceId,
        access: {
          enabled: confirmed.internetAccess ?? next.enabled,
          domainRestriction: confirmed.domainRestriction ?? next.domainRestriction,
          allowedDomains: confirmed.allowedDomains ?? next.allowedDomains,
        },
        source: resource.data,
      });
    },
    [workspaceId, access, resource.data],
  );

  const toggle = useCallback(() => change({ enabled: !access.enabled }), [change, access.enabled]);
  const toggleDomainRestriction = useCallback(
    () => change({ domainRestriction: !access.domainRestriction }),
    [change, access.domainRestriction],
  );
  const setAllowedDomains = useCallback((allowedDomains: string[]) => change({ allowedDomains }), [change]);

  return {
    enabled: access.enabled,
    domainRestriction: access.domainRestriction,
    allowedDomains: access.allowedDomains,
    loading: resource.loading,
    error: resource.error,
    reload: resource.reload,
    toggle,
    toggleDomainRestriction,
    setAllowedDomains,
  };
}
