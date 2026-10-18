// Internet-access toggle: off blocks http_get, apt_install and all shell egress at the network layer. State
// is shared with EnvVarsBlock via useWorkspaceInternetAccess.
"use client";

import { AsyncState } from "@/components/shared/AsyncState";

interface Props {
  enabled: boolean;
  onToggle: () => void;
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}

export default function InternetAccessBlock({ enabled, onToggle, loading = false, error = false, onRetry }: Props) {
  if (loading || error) {
    return (
      <div className="flex flex-col mt-4 border border-border rounded-card p-[16px_18px] bg-bg-tint">
        <span className="text-ms font-semibold text-text">Internet access</span>
        <AsyncState loading={loading} error={error} onRetry={onRetry} errorLabel="Couldn’t load internet access." />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 mt-4 border border-border rounded-card p-[16px_18px] bg-bg-tint">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="text-ms font-semibold text-text">Internet access</span>
          <span className={`text-xs ml-2 ${enabled ? "text-select" : "text-text-3"}`}>{enabled ? "On" : "Off"}</span>
        </div>
        <button
          className={`relative w-9 h-5 rounded-[10px] border-0 cursor-pointer transition-colors duration-200 p-0 flex-shrink-0 ${enabled ? "bg-primary" : "bg-border"}`}
          onClick={onToggle}
          aria-label={enabled ? "Disable internet access" : "Enable internet access"}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform duration-200 block ${enabled ? "translate-x-4" : ""}`}
          />
        </button>
      </div>

      {!enabled && (
        <p className="m-0 text-xs text-text-3">
          This workspace&apos;s container has no network route to the internet. apt/pip/npm installs, http_get, and
          configured secret-domain access are all blocked. Safe to leave the agent running unattended.
        </p>
      )}
    </div>
  );
}
