// LLM provider keys for the settings modal. Not useCredential: these come from the vendor and stay
// recoverable, so there's no reveal-once and "rotate" is just saving a new one.
"use client";

import { useCallback, useEffect, useState } from "react";
import { readApiError } from "@/lib/client/apiError";

/** One provider's key status. Mirrors ProviderKeyStatus — never carries the key itself. */
export interface ProviderKeyStatus {
  provider: string;
  hasKey: boolean;
  createdAt?: string;
  /** Last few characters of the stored key, so two of the operator's own keys can be told apart. */
  hint?: string;
}

const ENDPOINT = "/api/settings/provider-keys";

export function useProviderKeys(load: boolean) {
  const [providers, setProviders] = useState<ProviderKeyStatus[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(load);
  const [error, setError] = useState<string | null>(null);

  // A token bump, so the fetch lives in the effect and is cancelled when the modal closes.
  const [reloadToken, setReloadToken] = useState(0);
  const refresh = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    if (!load) return;
    // `active` drops a response that arrives after the modal closed or the component unmounted, so a
    // slow request cannot repopulate a list nobody is looking at — the same guard useCredential uses.
    let active = true;
    void (async () => {
      try {
        const res = await fetch(ENDPOINT);
        if (!active) return;
        if (!res.ok) {
          setError((await readApiError(res, "Could not read provider keys.")).error);
          return;
        }
        const body = (await res.json()) as { providers?: ProviderKeyStatus[] };
        if (!active) return;
        setProviders(body.providers ?? []);
        setError(null);
      } catch {
        if (active) setError("Could not reach the server.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [load, reloadToken]);

  // Re-read after each mutation: the server owns the hint, which is how an operator confirms which key is loaded.
  const save = useCallback(
    async (provider: string, apiKey: string) => {
      setBusy(provider);
      setError(null);
      try {
        const res = await fetch(`${ENDPOINT}/${encodeURIComponent(provider)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });
        if (!res.ok) {
          setError((await readApiError(res, "Could not save the key.")).error);
          return false;
        }
        refresh();
        return true;
      } catch {
        setError("Could not reach the server.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (provider: string) => {
      setBusy(provider);
      setError(null);
      try {
        const res = await fetch(`${ENDPOINT}/${encodeURIComponent(provider)}`, { method: "DELETE" });
        if (!res.ok) {
          setError((await readApiError(res, "Could not remove the key.")).error);
          return;
        }
        refresh();
      } catch {
        setError("Could not reach the server.");
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return { providers, busy, loading, error, save, remove, refresh };
}
