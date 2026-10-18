"use client";

import { SPINNER_DELAY_MS, useDelayed } from "@/lib/client/hooks/useDelayed";
import { Spinner } from "./Spinner";

// Centered spinner, shown only after delayMs so quick loads don't flash. Use delayMs={0} on a surface
// the user just opened.
export function LoadingState({
  label = "Loading…",
  className = "",
  delayMs = SPINNER_DELAY_MS,
}: {
  label?: string;
  className?: string;
  delayMs?: number;
}) {
  const passedDelay = useDelayed(true, delayMs);
  if (delayMs > 0 && !passedDelay) return null;
  return (
    <div className={`flex items-center justify-center text-text-3 text-[13px] ${className}`}>
      <div className="flex items-center gap-2" role="status">
        <Spinner decorative />
        <span>{label}</span>
      </div>
    </div>
  );
}
