// Domain allowlist section of InternetAccessBlock, shown only while internet access is on. UI only for now:
// the state is local and nothing enforces it yet.
"use client";

import { useState } from "react";
import { Switch } from "@/components/shared/Switch";

/** Reduces a typed URL or host to a bare lowercase host, e.g. "https://API.x.com/v1" → "api.x.com". */
function normalizeDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .split(/[/?#]/)[0];
}

export default function DomainAllowlistBlock() {
  const [enabled, setEnabled] = useState(false);
  const [domains, setDomains] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const saveDraft = () => {
    const domain = normalizeDomain(draft);
    if (!domain) return;
    setDomains((prev) => (prev.includes(domain) ? prev : [...prev, domain]));
    setDraft("");
    setAdding(false);
  };

  const cancelDraft = () => {
    setDraft("");
    setAdding(false);
  };

  const removeDomain = (domain: string) => setDomains((prev) => prev.filter((d) => d !== domain));

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
            setEnabled((v) => !v);
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
          {adding ? (
            <div className="flex items-center gap-2">
              <input
                className="input input-sm font-mono flex-1"
                autoFocus
                aria-label="New allowed domain"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveDraft();
                  if (e.key === "Escape") cancelDraft();
                }}
                onBlur={() => {
                  if (!draft.trim()) cancelDraft();
                }}
              />
              <button type="button" className="btn w-16 px-0" onClick={saveDraft} disabled={!normalizeDomain(draft)}>
                Save
              </button>
            </div>
          ) : (
            <button type="button" className="linkbtn px-0 text-primary self-start" onClick={() => setAdding(true)}>
              + Add domain
            </button>
          )}
        </div>
      )}
    </div>
  );
}
