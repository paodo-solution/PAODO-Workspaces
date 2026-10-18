// The home page's workspace list and its create/rename/delete, re-reading after each. Mutations return a
// MutationResult, since a rejected name is shown inline, not thrown.
"use client";

import { useState, useCallback } from "react";
import { readApiError, type MutationResult } from "@/lib/client/apiError";
import { useAsyncResource } from "./useAsyncResource";

export interface WorkspaceItem {
  id: string;
  name: string;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

export function useWorkspaces() {
  const [isCreating, setIsCreating] = useState(false);

  const {
    data,
    loading,
    error,
    reload: refresh,
  } = useAsyncResource<WorkspaceItem[]>(
    useCallback(async (signal: AbortSignal) => {
      const res = await fetch("/api/workspaces", { signal });
      if (!res.ok) throw new Error("Failed to load workspaces.");
      return (await res.json()) as WorkspaceItem[];
    }, []),
  );
  const workspaces = data ?? [];

  const create = useCallback(
    async (name: string): Promise<{ ok: true; workspace: WorkspaceItem } | { ok: false; error: string }> => {
      setIsCreating(true);
      try {
        const res = await fetch("/api/workspaces", {
          method: "POST",
          headers: JSON_HEADERS,
          body: JSON.stringify({ name }),
        });
        if (!res.ok) return readApiError(res, "Failed to create workspace.");
        const workspace = (await res.json()) as WorkspaceItem;
        await refresh();
        return { ok: true, workspace };
      } finally {
        setIsCreating(false);
      }
    },
    [refresh],
  );

  const rename = useCallback(
    async (id: string, name: string): Promise<MutationResult> => {
      const res = await fetch(`/api/workspaces/${id}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ name }),
      });
      if (!res.ok) return readApiError(res, "Failed to rename workspace.");
      await refresh();
      return { ok: true };
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
      await refresh();
    },
    [refresh],
  );

  return { workspaces, loading, error, isCreating, refresh, create, rename, remove };
}
