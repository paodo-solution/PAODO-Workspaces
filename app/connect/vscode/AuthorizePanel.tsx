// The one Authorize click: posts the request back same-origin, then sends the browser to VS Code's loopback
// listener, which takes the code and returns the browser to the home page.
"use client";

import { useState } from "react";

export default function AuthorizePanel({
  request,
  cancel,
}: {
  request: Record<string, string | undefined>;
  cancel: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authorize = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/connect/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      const body = (await response.json().catch(() => ({}))) as { redirect?: string; error?: string };
      if (!response.ok || !body.redirect) throw new Error(body.error ?? "VS Code could not be authorized.");
      window.location.assign(body.redirect);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="m-0 text-text-2">VS Code is asking to use this PAODO instance on your behalf.</p>
      {error && (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <a className="btn" href={cancel} aria-disabled={busy}>
          Cancel
        </a>
        <button className="btn btn-primary" onClick={() => void authorize()} disabled={busy}>
          {busy ? "Authorizing…" : "Authorize"}
        </button>
      </div>
    </div>
  );
}
