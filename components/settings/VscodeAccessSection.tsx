// "Allow VS Code connections" as a settings-modal section: one switch. Turning it off also signs out every
// VS Code that was connected.
"use client";

import { useEffect, useState } from "react";
import { Switch } from "@/components/shared/Switch";
import { useReadyOnce } from "@/lib/client/hooks/useReadyOnce";

export default function VscodeAccessSection({ open, onReady }: { open: boolean; onReady?: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useReadyOnce(enabled !== null || error !== null, onReady);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/settings/vscode-access", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Could not load VS Code connections."))))
      .then((data: { enabled: boolean }) => {
        if (!cancelled) setEnabled(data.enabled);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const toggle = async (next: boolean) => {
    setBusy(true);
    try {
      const res = await fetch("/api/settings/vscode-access", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error("Could not change VS Code connections.");
      setEnabled(((await res.json()) as { enabled: boolean }).enabled);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm font-semibold">Allow VS Code connections</span>
        <Switch
          checked={enabled ?? false}
          onChange={(next) => void toggle(next)}
          disabled={busy || enabled === null}
          ariaLabel={enabled ? "Disallow VS Code connections" : "Allow VS Code connections"}
        />
      </div>
      {error && (
        <p role="alert" className="mb-0 mt-3 text-xs text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
