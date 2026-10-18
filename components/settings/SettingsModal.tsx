// Instance-wide settings dialog (gear icon). Chrome only: each setting is its own section.
"use client";

import { useCallback, useEffect, useState } from "react";
import { LoadingState } from "@/components/shared/LoadingState";
import CliAccessSection from "./CliAccessSection";
import DiskUsageSection from "./DiskUsageSection";
import ProviderKeysSection from "./ProviderKeysSection";

const SECTION_COUNT = 3;

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const close = useCallback(() => onClose(), [onClose]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/30 px-4 pt-[8vh]"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) close();
      }}
    >
      <div
        className="max-h-[84vh] w-full max-w-[640px] overflow-y-auto rounded-card border border-border bg-white p-6 shadow-md"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
      >
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm font-semibold">Settings</span>
          <button className="iconbtn" onClick={close} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Mounted only while open, so its ready-gate starts fresh on every open with no reset. */}
        <SettingsBody />
      </div>
    </div>
  );
}

function SettingsBody() {
  // Count sections that have finished their first load; the body stays behind one spinner until all
  // are ready, so the modal opens on one spinner rather than three.
  const [readyCount, setReadyCount] = useState(0);
  const markReady = useCallback(() => setReadyCount((n) => n + 1), []);
  const loading = readyCount < SECTION_COUNT;

  return (
    <>
      {loading && <LoadingState className="mt-6 py-16" />}

      {/* Sections stay mounted while loading so they can fetch; revealed once all report ready. */}
      <div className={loading ? "hidden" : "mt-6 flex flex-col gap-8"}>
        <ProviderKeysSection open onReady={markReady} />
        <div className="border-t border-border" />
        <CliAccessSection open onReady={markReady} />
        <div className="border-t border-border" />
        <DiskUsageSection open onReady={markReady} />
      </div>
    </>
  );
}
