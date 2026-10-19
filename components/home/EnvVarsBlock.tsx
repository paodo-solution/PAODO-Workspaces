"use client";

import { useState, useEffect } from "react";
import type { ThirdPartySecret } from "@/lib/operations/workspace/secrets";
import { DOMAIN_FORMAT_ERROR, blockedHosts, isValidDomain } from "@/lib/workspace/domain";
import type { DomainAllowlist } from "@/lib/workspace/types";

export default function EnvVarsBlock({ wsId, allowlist }: { wsId: string; allowlist: DomainAllowlist }) {
  const [secrets, setSecrets] = useState<ThirdPartySecret[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [domains, setDomains] = useState<string[]>([""]);
  const [showForm, setShowForm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [domainBlurred, setDomainBlurred] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/workspaces/${wsId}/env-vars`)
      .then((r) => r.json())
      .then((d: ThirdPartySecret[]) => setSecrets(d))
      .catch(() => {});
  }, [wsId]);

  const resetForm = () => {
    setName("");
    setValue("");
    setDomains([""]);
    setError(null);
    setDomainBlurred(false);
  };

  const setDomainValue = (idx: number, val: string) => {
    setDomainBlurred(false);
    setDomains((prev) => prev.map((d, i) => (i === idx ? val : d)));
  };

  const addDomainField = () => setDomains((prev) => [...prev, ""]);

  const removeDomainField = (idx: number) => {
    setDomains((prev) => (prev.length === 1 ? [""] : prev.filter((_, i) => i !== idx)));
  };

  const trimmedDomains = domains.map((d) => d.trim()).filter((d) => d.length > 0);
  const hasInvalidDomain = trimmedDomains.some((d) => !isValidDomain(d));

  const add = async () => {
    setError(null);
    setAdding(true);
    try {
      const res = await fetch(`/api/workspaces/${wsId}/env-vars`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), value: value.trim(), domains: trimmedDomains }),
      });
      if (!res.ok) {
        const d = (await res.json()) as { error?: string };
        setError(d.error ?? "Failed to save");
        return;
      }
      resetForm();
      setShowForm(false);
      const updated = (await fetch(`/api/workspaces/${wsId}/env-vars`).then((r) => r.json())) as ThirdPartySecret[];
      setSecrets(updated);
    } finally {
      setAdding(false);
    }
  };

  const hasMismatch = secrets.some((s) => blockedHosts(s.domains, allowlist).length > 0);

  const remove = async (secretName: string) => {
    await fetch(`/api/workspaces/${wsId}/env-vars/${encodeURIComponent(secretName)}`, { method: "DELETE" });
    setConfirmDelete(null);
    setSecrets((prev) => prev.filter((s) => s.name !== secretName));
  };

  return (
    <div className="flex flex-col gap-3 mt-4 border border-border rounded-card p-[14px_16px] bg-bg-tint">
      <div>
        <span className="text-ms font-semibold text-text">Third-party secrets</span>
        <span className="text-xs text-text-3 ml-2">kept out of the agent&apos;s context</span>
      </div>

      {secrets.length > 0 && (
        <div className="flex flex-col gap-2">
          {secrets.map((s) => (
            <div key={s.name} className="flex items-center gap-2">
              <div className="input input-sm font-mono flex-1 min-w-0 flex items-center gap-2 bg-bg-deep text-text-3">
                <span className="shrink-0">{s.name}</span>
                {s.domains?.length ? <span className="truncate">→ {s.domains.join(", ")}</span> : null}
              </div>
              {confirmDelete === s.name ? (
                <div className="flex items-center gap-2 shrink-0">
                  <button className="btn btn-danger btn-sm" onClick={() => remove(s.name)}>
                    Delete
                  </button>
                  <button className="linkbtn" onClick={() => setConfirmDelete(null)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="border-0 bg-transparent p-0 text-lg leading-none text-danger cursor-pointer hover:opacity-70 shrink-0"
                  aria-label={`Remove ${s.name}`}
                  onClick={() => setConfirmDelete(s.name)}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {!showForm ? (
        <button
          type="button"
          className="linkbtn px-0 text-primary self-start"
          onClick={() => {
            resetForm();
            setShowForm(true);
          }}
        >
          + Add secret
        </button>
      ) : (
        <div className="flex flex-col gap-3 bg-white border border-border rounded-ctrl p-[12px_14px]">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text">Name</span>
            <input
              className="input input-sm font-mono"
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text">Value</span>
            <input
              className="input input-sm"
              type="password"
              autoComplete="new-password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium text-text">Allowed domains</span>
            <div className="flex flex-col gap-2">
              {domains.map((domain, idx) => (
                <div className="flex items-center gap-2" key={idx}>
                  <input
                    className="input input-sm font-mono flex-1"
                    value={domain}
                    onChange={(e) => setDomainValue(idx, e.target.value)}
                    onBlur={() => setDomainBlurred(true)}
                  />
                  {domains.length > 1 && (
                    <button
                      type="button"
                      className="border-0 bg-transparent p-0 text-lg leading-none text-danger cursor-pointer hover:opacity-70"
                      aria-label="Remove domain"
                      onClick={() => removeDomainField(idx)}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
            {domainBlurred && hasInvalidDomain && <p className="text-xs text-danger m-0">{DOMAIN_FORMAT_ERROR}</p>}
            <button type="button" className="linkbtn px-0 text-primary mt-1 self-start" onClick={addDomainField}>
              + Add domain
            </button>
          </div>

          {error && <p className="text-xs text-danger m-0">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              className="btn btn-sm"
              onClick={add}
              disabled={adding || !name || !value || trimmedDomains.length === 0 || hasInvalidDomain}
            >
              {adding ? "Saving…" : "Save secret"}
            </button>
            <button
              className="linkbtn"
              onClick={() => {
                setShowForm(false);
                resetForm();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {hasMismatch && (
        <p className="text-xs text-danger m-0">Some secrets won&apos;t work because their domains are not allowed.</p>
      )}
    </div>
  );
}
