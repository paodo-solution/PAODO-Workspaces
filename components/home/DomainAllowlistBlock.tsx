// Domain allowlist section of InternetAccessBlock, shown only while internet access is on. The saved state
// comes from useWorkspaceInternetAccess; only the domain being typed is local.
"use client";

import { useState } from "react";
import { Switch } from "@/components/shared/Switch";
import { DOMAIN_FORMAT_ERROR, isValidDomain, normalizeDomain } from "@/lib/workspace/domain";

interface Props {
  enabled: boolean;
  domains: string[];
  onToggle: () => void;
  /** Receives the whole new list. */
  onChangeDomains: (domains: string[]) => void;
}

export default function DomainAllowlistBlock({ enabled, domains, onToggle, onChangeDomains }: Props) {
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [draftBlurred, setDraftBlurred] = useState(false);
  const draftValid = isValidDomain(draft);

  const saveDraft = () => {
    if (!draftValid) {
      setDraftBlurred(true);
      return;
    }
    const domain = normalizeDomain(draft);
    if (!domains.includes(domain)) onChangeDomains([...domains, domain]);
    cancelDraft();
  };

  const cancelDraft = () => {
    setDraft("");
    setDraftBlurred(false);
    setAdding(false);
  };

  const removeDomain = (domain: string) => onChangeDomains(domains.filter((d) => d !== domain));

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
              <button
                type="button"
                className="border-0 bg-transparent p-0 text-lg leading-none text-danger cursor-pointer hover:opacity-70"
                aria-label={`Remove ${domain}`}
                onClick={() => removeDomain(domain)}
              >
                ×
              </button>
            </div>
          ))}
          {adding && (
            <div className="flex items-center gap-2">
              <input
                className="input input-sm font-mono flex-1"
                autoFocus
                aria-label="New allowed domain"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setDraftBlurred(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveDraft();
                  if (e.key === "Escape") cancelDraft();
                }}
                onBlur={() => {
                  if (!draft.trim()) cancelDraft();
                  else setDraftBlurred(true);
                }}
              />
              <button type="button" className="btn w-16 px-0" onClick={saveDraft} disabled={!draftValid}>
                Save
              </button>
            </div>
          )}
          {adding && draftBlurred && !draftValid && <p className="text-xs text-danger m-0">{DOMAIN_FORMAT_ERROR}</p>}
          {!adding && (
            <button type="button" className="linkbtn px-0 text-primary self-start" onClick={() => setAdding(true)}>
              + Add domain
            </button>
          )}
          {domains.length === 0 && (
            <p className="text-xs text-danger m-0">No allowed domain is set</p>
          )}
        </div>
      )}
    </div>
  );
}
