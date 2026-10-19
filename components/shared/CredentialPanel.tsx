// Card for a workspace access channel (API access, MCP). Switch and key controls are independent, so a key can
// be issued before opening or revoked after closing. Says "key": "secret" means env-var secrets on this page.
"use client";

import { useState, type ReactNode } from "react";
import { AsyncState } from "./AsyncState";
import CredentialConfirm, { type CredentialAction } from "./CredentialConfirm";
import CredentialReveal from "./CredentialReveal";
import { Switch } from "./Switch";

interface CredentialPanelProps {
  title: string;
  /** One line explaining what opening the channel does. Shown only while enabled. */
  description: string;
  /** Label for the toggle's accessible name, e.g. "API access". */
  toggleLabel: string;
  enabled: boolean;
  hasKey: boolean;
  /** The reveal-once plaintext, present only between minting it and dismissing it. */
  plaintext: string | null;
  busy: boolean;
  error: string | null;
  /** The initial GET is in flight / failed — the body becomes a spinner / retry instead of controls. */
  loading?: boolean;
  loadError?: boolean;
  onRetry?: () => void;
  onToggle: () => void;
  /** Issues the channel's first credential. Offered only while it has none. */
  onGenerate: () => void;
  /** Replaces the existing credential. Offered only while it has one. */
  onRotate: () => Promise<void>;
  onRevoke: () => Promise<void>;
  onDismissPlaintext: () => void;
  /** Channel-specific content rendered while enabled, above the controls (MCP's tools and URL). */
  children?: ReactNode;
}

export default function CredentialPanel({
  title,
  description,
  toggleLabel,
  enabled,
  hasKey,
  plaintext,
  busy,
  error,
  loading = false,
  loadError = false,
  onRetry,
  onToggle,
  onGenerate,
  onRotate,
  onRevoke,
  onDismissPlaintext,
  children,
}: CredentialPanelProps) {
  const [confirming, setConfirming] = useState<CredentialAction | null>(null);

  const runConfirmed = async () => {
    await (confirming === "rotate" ? onRotate() : onRevoke());
    setConfirming(null);
  };

  if (loading || loadError) {
    return (
      <div className="flex flex-col mt-4 border border-border rounded-card p-[16px_18px] bg-bg-tint">
        <span className="text-ms font-semibold text-text">{title}</span>
        <AsyncState
          loading={loading}
          error={loadError}
          onRetry={onRetry}
          errorLabel={`Couldn’t load ${title.toLowerCase()}.`}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 mt-4 border border-border rounded-card p-[16px_18px] bg-bg-tint">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="text-ms font-semibold text-text">{title}</span>
          <span className={`text-xs ml-2 ${enabled && hasKey ? "text-select" : "text-text-3"}`}>
            {statusLabel(enabled, hasKey)}
          </span>
        </div>
        <Switch
          checked={enabled}
          onChange={onToggle}
          disabled={busy}
          ariaLabel={enabled ? `Disable ${toggleLabel}` : `Enable ${toggleLabel}`}
        />
      </div>

      {error && (
        <p className="m-0 text-xs text-danger" role="alert">
          {error}
        </p>
      )}

      {/* Channel and MCP details are true only of a live channel, so they stay behind the switch. */}
      {enabled && (
        <>
          <p className="m-0 text-xs text-text-3">{description}</p>
          {children}
        </>
      )}

      {!hasKey && !plaintext && (
        <button className="btn btn-sm self-start" onClick={onGenerate} disabled={busy}>
          {busy ? "Generating…" : "Generate key"}
        </button>
      )}

      {hasKey && !plaintext && (
        <div className="flex items-center gap-2.5">
          <button className="linkbtn" onClick={() => setConfirming("rotate")} disabled={busy}>
            Rotate
          </button>
          <button className="linkbtn text-danger" onClick={() => setConfirming("revoke")} disabled={busy}>
            Revoke
          </button>
        </div>
      )}

      {plaintext && <CredentialReveal plaintext={plaintext} onDismiss={onDismissPlaintext} />}

      {confirming && (
        <CredentialConfirm
          action={confirming}
          busy={busy}
          onConfirm={() => void runConfirmed()}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}

// Names both axes at once. A closed channel that still holds a key says so rather than reading as a
// bare "Disabled", which would suggest the key was gone and leave no reason to look for Revoke.
function statusLabel(enabled: boolean, hasKey: boolean): string {
  if (!enabled) return hasKey ? "Disabled · key exists" : "Disabled";
  return hasKey ? "Key active" : "Key required";
}
