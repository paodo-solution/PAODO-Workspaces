import { useCallback, useEffect, useRef } from "react";

type ResizeCursor = "col-resize" | "row-resize";

interface UseDragResizeOptions {
  // Called on every mousemove during a drag; computes and sets the new size. Caller-side so each site's
  // geometry stays visible where it's used.
  onMove: (e: MouseEvent) => void;
  /** Body cursor shown for the duration of the drag. Defaults to horizontal (column) resize. */
  cursor?: ResizeCursor;
  // Notified when a drag starts (true) and ends (false). Wire it to an `isDragging` state to, e.g.,
  // overlay a pointer-events shield so an iframe/CodeMirror doesn't swallow the mouse mid-drag.
  onDragChange?: (dragging: boolean) => void;
}

// Shared drag boilerplate for resizable dividers: listeners, guard, body cursor and cleanup. Bind the
// returned `startDrag` to the divider's `onMouseDown`.
export function useDragResize({ onMove, cursor = "col-resize", onDragChange }: UseDragResizeOptions): () => void {
  const dragging = useRef(false);
  // Latest callbacks in refs (written in an effect), so inline closures don't re-subscribe the listeners.
  const onMoveRef = useRef(onMove);
  const onDragChangeRef = useRef(onDragChange);
  useEffect(() => {
    onMoveRef.current = onMove;
    onDragChangeRef.current = onDragChange;
  });

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (dragging.current) onMoveRef.current(e);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onDragChangeRef.current?.(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  return useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
    onDragChangeRef.current?.(true);
  }, [cursor]);
}
