/**
 * Loads and toggles a workspace's internet-access flag. A failed read is an `error`, never "off"; the
 * toggle is optimistic and rolls back on rejection. Shared by InternetAccessBlock and EnvVarsBlock.
 */
"use client";

import { useState, useCallback } from "react";
import { confirmedValues } from "@/lib/client/workspaceReceipt";
import { fetchJson } from "@/lib/client/fetchJson";
import { useAsyncResource } from "./useAsyncResource";

interface Access {
  enabled: boolean;
}

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
  const [override, setOverride] = useState<{ id: string; enabled: boolean; source: Access | null } | null>(null);
  const enabled =
    override && override.id === workspaceId && override.source === resource.data
      ? override.enabled
      : (resource.data?.enabled ?? false);

  // Optimistic: the toggle renders immediately and is rolled back if the PATCH fails, so a
  // rejected save never leaves the switch showing a state the server didn't keep.
  const toggle = useCallback(async () => {
    if (!workspaceId) return;
    const next = !enabled;
    setOverride({ id: workspaceId, enabled: next, source: resource.data });
    const res = await fetch(`/api/workspaces/${workspaceId}/internet-access`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    if (!res.ok) {
      setOverride({ id: workspaceId, enabled: !next, source: resource.data });
      return;
    }
    const { internetAccess } = await confirmedValues(res);
    setOverride({ id: workspaceId, enabled: internetAccess ?? next, source: resource.data });
  }, [workspaceId, enabled, resource.data]);

  return { enabled, loading: resource.loading, error: resource.error, reload: resource.reload, toggle };
}
