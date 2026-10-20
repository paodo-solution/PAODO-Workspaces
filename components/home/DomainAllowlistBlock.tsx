// Domain allowlist section of InternetAccessBlock, shown only while internet access is on. The saved state
// comes from useWorkspaceInternetAccess; only the domain being typed is local.
"use client";

import { useState } from "react";
import DomainField from "@/components/shared/DomainField";
import RemoveButton from "@/components/shared/RemoveButton";
import { Switch } from "@/components/shared/Switch";
import { isValidDomain, normalizeDomain } from "@/lib/workspace/domain";

interface Props {
  enabled: boolean;
  domains: string[];
  onToggle: () => void;
  onAddDomain: (domain: string) => void;
  onRemoveDomain: (domain: string) => void;
}

export default function DomainAllowlistBlock({ enabled, domains, onToggle, onAddDomain, onRemoveDomain }: Props) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const draftValid = isValidDomain(draft);

  const saveDraft = () => {
    if (!draftValid) return;
    const domain = normalizeDomain(draft);
    if (!domains.includes(domain)) onAddDomain(domain);
    cancelDraft();
  };

  const cancelDraft = () => {
    setDraft("");
    setAdding(false);
  };

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="text-ms font-semibold text-text">Restrict to allowed domains</span>
          <span className={`text-xs ml-2 ${enabled ? "text-select" : "text-text-3"}`}>{enabled ? "On" : "Off"}</span>
        </div>
        <Switch
          checked={enabled}
          onChange={() => {
            onToggle();
            cancelDraft();
          }}
          ariaLabel={enabled ? "Stop restricting to allowed domains" : "Restrict to allowed domains"}
        />
      </div>

      {enabled && (
        <div className="flex flex-col gap-2">
          {domains.map((domain) => (
            <div className="flex items-center gap-2" key={domain}>
              <input
                className="input input-sm font-mono flex-1 bg-bg-deep text-text-3 cursor-not-allowed"
                value={domain}
                disabled
                aria-label={`Allowed domain ${domain}`}
              />
              <RemoveButton label={`Remove ${domain}`} onClick={() => onRemoveDomain(domain)} />
            </div>
          ))}
          {adding && (
            <DomainField
              autoFocus
              ariaLabel="New allowed domain"
              value={draft}
              onChange={setDraft}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveDraft();
                if (e.key === "Escape") cancelDraft();
              }}
              onBlur={() => {
                if (!draft.trim()) cancelDraft();
              }}
            >
              <button type="button" className="btn w-16 px-0" onClick={saveDraft} disabled={!draftValid}>
                Save
              </button>
            </DomainField>
          )}
          {!adding && (
            <button type="button" className="linkbtn px-0 text-primary self-start" onClick={() => setAdding(true)}>
              + Add domain
            </button>
          )}
          {domains.length === 0 && <p className="text-xs text-danger m-0">No allowed domain is set</p>}
        </div>
      )}
    </div>
  );
}
