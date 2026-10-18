// A workspace's disk usage, the home page's slowest fetch, so callers show a spinner and retry. Stale
// responses for a previous workspace are dropped; idle when none is selected.
"use client";

import { useCallback } from "react";
import { fetchJson } from "@/lib/client/fetchJson";
import { useAsyncResource, type AsyncResource } from "./useAsyncResource";

export interface WorkspaceStorage {
  workspaceId: string;
  bytes: number;
  breakdown: { workspace: number; home: number; versioning: number };
}

export function useWorkspaceStorage(workspaceId: string | null): AsyncResource<WorkspaceStorage> {
  return useAsyncResource<WorkspaceStorage>(
    useCallback(
      (signal) =>
        fetchJson<WorkspaceStorage>(`/api/workspaces/${workspaceId}/storage`, signal, "Failed to load storage usage.", {
          cache: "no-store",
        }),
      [workspaceId],
    ),
    { enabled: workspaceId !== null },
  );
}
