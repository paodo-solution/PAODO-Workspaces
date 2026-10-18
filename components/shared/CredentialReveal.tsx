// The one moment a minted key is visible, identical for every credential. Prop is `plaintext` (`key` is
// reserved by React).
"use client";

import { useState } from "react";

interface CredentialRevealProps {
  plaintext: string;
  onDismiss?: () => void;
}

export default function CredentialReveal({ plaintext, onDismiss }: CredentialRevealProps) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(plaintext);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-white border border-border rounded-ctrl p-[12px_14px] flex flex-col gap-2">
      <p className="m-0 text-xs text-danger font-medium">Save this key — it won&apos;t be shown again.</p>
      <div className="flex items-start gap-2">
        <code className="font-mono text-xs leading-[1.4] text-text bg-bg-tint px-2 py-1 rounded border border-border flex-1 min-w-0 break-all">
          {plaintext}
        </code>
        <button className="btn btn-sm" onClick={copy}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      {onDismiss && (
        <button className="linkbtn" onClick={onDismiss}>
          Close
        </button>
      )}
    </div>
  );
}
