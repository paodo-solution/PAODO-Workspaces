// File-tree selection (cascading, shift ranges, remap after moves), separate from network operations.

import { useState } from "react";
import { remapMovedPath } from "../fileMove";
import { flattenVisible, selectionRange } from "../fileTreeOrder";
import type { TreeNode } from "./useFileOperations";

export function useFileTreeSelection() {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Shift+click ranges measure from the last plain-click row, so a range can grow and shrink without re-anchoring.
  const [anchorPath, setAnchorPath] = useState<string | null>(null);

  const handleSelect = (paths: string[], on: boolean) => {
    // Callers pass the clicked node first, then any descendants it cascades to.
    setAnchorPath(paths[0] ?? null);
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) {
        if (on) next.add(p);
        else next.delete(p);
      }
      return next;
    });
  };

  /** Adds a range on top of the current selection, deliberately leaving the anchor where it is. */
  const selectPaths = (paths: string[]) => {
    if (paths.length === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const p of paths) next.add(p);
      return next;
    });
  };

  const selectRangeTo = (tree: TreeNode[], expanded: Record<string, boolean>, targetPath: string) => {
    const rows = flattenVisible(tree, expanded);
    const range = selectionRange(rows, anchorPath, targetPath);
    if (range.length === 0) return;

    const hasAnchor = anchorPath !== null && rows.some((node) => node.path === anchorPath);
    if (hasAnchor) selectPaths(range);
    else handleSelect(range, true);
  };

  const clearSelection = () => {
    setSelected(new Set());
    setAnchorPath(null);
  };

  const remapSelection = (sourceRoot: string, destinationRoot: string) => {
    setSelected(
      (prev) => new Set(Array.from(prev, (path) => remapMovedPath(path, sourceRoot, destinationRoot) ?? path)),
    );
    setAnchorPath((current) => remapMovedPath(current, sourceRoot, destinationRoot));
  };

  return {
    selected,
    handleSelect,
    selectRangeTo,
    clearSelection,
    remapSelection,
  };
}
