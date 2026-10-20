// Generic confirmation dialog for actions that can't be undone. Portalled to <body> so it sits above the
// settings dialog, and its Escape is caught first so it closes only itself.
"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Spinner } from "./Spinner";

interface ConfirmModalProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Shown with a spinner while the action runs, e.g. "Revoking…". */
  busyLabel: string;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export default function ConfirmModal({
  title,
  children,
  confirmLabel,
  busyLabel,
  busy,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (!busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [busy, onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 bg-[rgba(15,10,30,0.55)] backdrop-blur-[2px] flex items-center justify-center z-[1000] p-4"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !busy) onCancel();
      }}
    >
      <div
        className="bg-white rounded-2xl shadow-[0_18px_50px_rgba(15,10,30,0.28)] p-7 w-[min(420px,calc(100vw-32px))] border border-[rgba(15,10,30,0.08)]"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="font-semibold text-[17px] text-text leading-snug">{title}</div>
        <p className="text-sm text-text-2 mt-1.5 mb-0 leading-[1.55]">{children}</p>

        <div className="flex gap-2.5 items-center justify-end mt-7">
          {busy ? (
            <div className="flex items-center gap-2.5 text-sm text-text-2">
              <Spinner />
              {busyLabel}
            </div>
          ) : (
            <>
              <button className="btn btn-primary" onClick={onCancel}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={onConfirm}>
                {confirmLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
