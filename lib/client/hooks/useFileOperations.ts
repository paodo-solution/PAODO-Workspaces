// The lazily loaded file tree plus bulk download, delete and drag-move on the selection. Deletes run in
// parallel with a transient error; a drag sends the batch as one PATCH.
import { useRef } from "react";
import { useFileTree } from "./useFileTree";
export type { TreeNode } from "../fileTreeResource";
import { collapseToRoots } from "../fileMove";
import { useDeferredPending } from "./useDeferredPending";
import { useTransientMessage } from "./useTransientMessage";

/** What the server did with one item of a move batch. */
export interface MoveResult {
  sourcePath: string;
  /** The item's authoritative new path — equal to sourcePath when unchanged. */
  path: string;
  /** The item was already in the destination, so nothing moved. */
  unchanged: boolean;
}

export interface MoveBatchOutcome {
  results: MoveResult[];
  error: string | null;
}

interface Options {
  workspaceId: string;
  workspaceName: string;
  selected: Set<string>;
  clearSelection: () => void;
  onDeletedPaths?: (paths: string[]) => void;
  refreshKey?: number;
  /** API base for file routes. Defaults to the workspace path; drives pass /api/drives/<id>. */
  apiBase?: string;
}

export function useFileOperations({
  workspaceId,
  workspaceName,
  selected,
  clearSelection,
  onDeletedPaths,
  refreshKey,
  apiBase,
}: Options) {
  const base = apiBase ?? `/api/workspaces/${workspaceId}`;
  const fileTree = useFileTree(base, refreshKey);
  const { refreshTree } = fileTree;
  const { pending: downloading, run: runDownload } = useDeferredPending();
  const [deleteError, setDeleteError] = useTransientMessage(2000);
  const [moveError, setMoveError] = useTransientMessage(3500);
  const [downloadError, setDownloadError] = useTransientMessage(3500);
  const moveInFlightRef = useRef(false);
  const handleDownload = () =>
    runDownload(async () => {
      setDownloadError(null);
      try {
        const res = await fetch(`${base}/files/download`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: Array.from(selected) }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
          setDownloadError((body.error || body.message) ?? `Download failed: ${res.status} ${res.statusText}`);
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${workspaceName}.zip`;
        // The anchor must be in the DOM for Firefox to honor the click, and the object URL must outlive
        // the click — modern browsers cancel the download if it's revoked synchronously, so defer it.
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } catch {
        setDownloadError("Download failed");
      }
    });

  const handleDelete = async () => {
    const paths = Array.from(selected);
    const roots = collapseToRoots(paths);
    setDeleteError(null);
    const failures: string[] = [];
    try {
      const resArr = await Promise.all(
        roots.map((p) =>
          fetch(`${base}/files/content?path=${encodeURIComponent(p)}`, {
            method: "DELETE",
          }),
        ),
      );
      for (const r of resArr) {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}) as { error?: string; message?: string });
          failures.push((body.error || body.message) ?? `${r.status} ${r.statusText}`);
        }
      }
      if (failures.length > 0) {
        const uniq = Array.from(new Set(failures));
        setDeleteError(uniq.length === 1 ? `Failed to delete: ${uniq[0]}` : `Failed to delete: ${uniq.join("; ")}`);
      }
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    }
    if (failures.length === 0) {
      clearSelection();
      onDeletedPaths?.(paths);
    }
    refreshTree();
  };

  // One request, one refresh. Returns per-item results plus any stopping error (null if unparseable).
  // Trust the server's `unchanged`; tree paths and realpaths can differ.
  const handleMoveMany = async (
    sourcePaths: string[],
    destinationDirectory: string | null,
  ): Promise<MoveBatchOutcome | null> => {
    if (moveInFlightRef.current) {
      setMoveError("Another move is still in progress");
      return null;
    }
    moveInFlightRef.current = true;
    setMoveError(null);
    try {
      const res = await fetch(`${base}/files/content`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourcePaths, destinationDirectory }),
      });
      const body = (await res.json().catch(() => ({}))) as { results?: MoveResult[]; error?: string };
      // A rejected batch still carries results (an empty list); only a malformed request omits them.
      if (!Array.isArray(body.results)) {
        setMoveError(body.error || `Move failed: ${res.status} ${res.statusText}`);
        return null;
      }
      if (body.error) setMoveError(body.error);
      await refreshTree();
      return { results: body.results, error: body.error ?? null };
    } catch {
      setMoveError("Move failed");
      return null;
    } finally {
      moveInFlightRef.current = false;
    }
  };

  return {
    ...fileTree,
    handleDownload,
    downloading,
    downloadError,
    handleDelete,
    deleteError,
    handleMoveMany,
    moveError,
  };
}
