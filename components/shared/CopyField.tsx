// Read-only value with a Copy button, styled like the saved domain and secret rows so it reads as fixed.
"use client";

import { useState } from "react";

export default function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-text">{label}</span>
      <div className="flex items-center gap-2">
        <input
          className="input input-sm font-mono text-xs flex-1 min-w-0 bg-bg-deep text-text focus:border-border focus:shadow-none"
          value={value}
          readOnly
          aria-label={label}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button type="button" className="btn w-16 px-0" onClick={() => void copy()}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}
