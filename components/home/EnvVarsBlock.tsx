"use client";

import { useState, useEffect } from "react";
import DomainField from "@/components/shared/DomainField";
import RemoveButton from "@/components/shared/RemoveButton";
import type { ThirdPartySecret } from "@/lib/operations/workspace/secrets";
import { blockedHosts, isValidDomain } from "@/lib/workspace/domain";
import type { DomainAllowlist } from "@/lib/workspace/types";

// A stable id per domain row, so removing one row never hands its DomainField state to the next.
interface DomainRow {
  id: number;
  value: string;
}

let nextRowId = 0;
const blankRow = (): DomainRow => ({ id: nextRowId++, value: "" });

export default function EnvVarsBlock({ wsId, allowlist }: { wsId: string; allowlist: DomainAllowlist }) {
  const [secrets, setSecrets] = useState<ThirdPartySecret[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [domains, setDomains] = useState<DomainRow[]>(() => [blankRow()]);
  const [showForm, setShowForm] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/workspaces/${wsId}/env-vars`)
      .then((r) => r.json())
      .then((d: ThirdPartySecret[]) => setSecrets(d))
      .catch(() => {});
  }, [wsId]);

  const resetForm = () => {
    setName("");
    setValue("");
    setDomains([blankRow()]);
    setError(null);
  };

  const setDomainValue = (id: number, val: string) => {
    setDomains((prev) => prev.map((row) => (row.id === id ? { ...row, value: val } : row)));
  };

  const addDomainField = () => setDomains((prev) => [...prev, blankRow()]);

  const removeDomainField = (id: number) => {
    setDomains((prev) => (prev.length === 1 ? [blankRow()] : prev.filter((row) => row.id !== id)));
  };

  const trimmedDomains = domains.map((row) => row.value.trim()).filter((d) => d.length > 0);
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
              <RemoveButton label={`Remove ${s.name}`} onClick={() => remove(s.name)} />
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
              {domains.map((row) => (
                <DomainField key={row.id} value={row.value} onChange={(val) => setDomainValue(row.id, val)}>
                  {domains.length > 1 && (
                    <RemoveButton label="Remove domain" onClick={() => removeDomainField(row.id)} />
                  )}
                </DomainField>
              ))}
            </div>
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
