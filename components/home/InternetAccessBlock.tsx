// Internet-access toggle: off blocks http_get, apt_install and all shell egress at the network layer. State
// is shared with EnvVarsBlock via useWorkspaceInternetAccess.
"use client";

import { AsyncState } from "@/components/shared/AsyncState";
import { Switch } from "@/components/shared/Switch";
import DomainAllowlistBlock from "./DomainAllowlistBlock";

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
        <Switch
          checked={enabled}
          onChange={onToggle}
          ariaLabel={enabled ? "Disable internet access" : "Enable internet access"}
        />
      </div>

      {enabled && <DomainAllowlistBlock />}

      {!enabled && (
        <p className="m-0 text-xs text-text-3">
          This workspace&apos;s container has no network route to the internet. apt/pip/npm installs, http_get, and
          configured secret-domain access are all blocked. Safe to leave the agent running unattended.
        </p>
      )}
    </div>
  );
}
