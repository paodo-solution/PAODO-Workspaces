// One credential's lifecycle for every key panel (credentialRoutes.ts). Generate and rotate stay
// separate so a click never replaces a live key; a 409 means stale state and triggers a resync.
"use client";

import { useCallback, useEffect, useState } from "react";
import { readApiError, type ApiFailure } from "@/lib/client/apiError";
import { confirmedValues } from "@/lib/client/workspaceReceipt";
import { fetchJson } from "@/lib/client/fetchJson";
import { useAsyncResource } from "./useAsyncResource";

/** The credential fields every endpoint returns, matching CredentialState in credentialStore.ts. */
export interface CredentialSnapshot {
  enabled: boolean;
  hasKey: boolean;
  createdAt: string | null;
  lastUsedAt: string | null;
}

interface Labels {
  /** What the channel is called, e.g. "API access", "MCP settings", "CLI access". */
  feature: string;
}

interface CredentialOptions {
  load?: boolean;
  /** Receipt field holding the confirmed on/off state; omitted by the CLI channel, which has none. */
  accessField?: "workspaceApiAccess" | "workspaceMcpAccess";
  /** Mint-response field holding the plaintext, e.g. `workspaceApiKey`; the CLI channel uses `plain`. */
  keyField?: string;
}

/** `TExtra` is the rest of the GET payload (base URL, skills), exposed as `extra`. */
export function useCredential<TExtra extends object = Record<string, never>>(
  endpoint: string,
  { feature }: Labels,
  { load = true, accessField, keyField = "plain" }: CredentialOptions = {},
) {
  const [enabled, setEnabled] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  // The transient plaintext, alive only until dismissed (hasKey is the durable fact). Not named `key`,
  // which React reserves.
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [extra, setExtra] = useState<TExtra | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);

  const fail = (err: unknown, fallback: string) =>
    setFailure({
      ok: false,
      code: "NETWORK_ERROR",
      error: err instanceof Error ? err.message : fallback,
    });

  // A failed first read replaces the panel with a retry; a failed mutation (`failure`) shows a banner above the
  // controls.
  const resource = useAsyncResource<CredentialSnapshot & TExtra>(
    useCallback(
      (signal) => fetchJson<CredentialSnapshot & TExtra>(endpoint, signal, `Could not load ${feature}.`),
      [endpoint, feature],
    ),
    { enabled: load },
  );

  // Seed the mutable channel state from each completed load; the mutations below then drive it from
  // here, so a resync or optimistic toggle is never clobbered by a stale load.
  useEffect(() => {
    const data = resource.data;
    if (!data) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setFailure(null);
    setEnabled(data.enabled);
    setHasKey(data.hasKey);
    setExtra(data as unknown as TExtra);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [resource.data]);

  const toggle = useCallback(async () => {
    const next = !enabled;
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!response.ok) {
        setFailure(await readApiError(response, `Could not update ${feature}.`));
        return;
      }
      // The toggle moves one axis and never produces a credential, so there is nothing to reveal
      // here — only the server's confirmed flag to adopt in place of the value we assumed.
      const values = await confirmedValues(response);
      setEnabled((accessField ? values[accessField] : undefined) ?? next);
    } catch (err) {
      fail(err, `Could not update ${feature}.`);
    } finally {
      setBusy(false);
    }
  }, [enabled, endpoint, feature, accessField]);

  // After a 409 (someone else changed the key), adopts the server's state so the panel shows the button
  // that now applies.
  const resync = useCallback(async () => {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) return;
      const body = (await response.json()) as CredentialSnapshot & TExtra;
      setEnabled(body.enabled);
      setHasKey(body.hasKey);
      setExtra(body as unknown as TExtra);
    } catch {
      // Best effort. The conflict message already stands on its own; a failed refresh must not
      // replace it with a less specific network error.
    }
  }, [endpoint]);

  /** The returned plaintext is the only time the credential exists outside the server. */
  const issue = useCallback(
    async (operation: "generate" | "rotate") => {
      setBusy(true);
      setFailure(null);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ operation }),
        });
        if (!response.ok) {
          setFailure(await readApiError(response, `Could not ${operation} the key.`));
          if (response.status === 409) await resync();
          return;
        }
        const body = (await response.json()) as Record<string, unknown>;
        const plain = body[keyField];
        if (typeof plain !== "string" || !plain) throw new Error("The server returned an invalid key.");
        setPlaintext(plain);
        setHasKey(true);
        // Deliberately does not touch `enabled`: issuing a credential is the other axis, and a key
        // may legitimately be issued while the channel is still closed.
      } catch (err) {
        fail(err, `Could not ${operation} the key.`);
      } finally {
        setBusy(false);
      }
    },
    [endpoint, resync, keyField],
  );

  /** Issues a first credential. Fails if one already exists — rotate that one instead. */
  const generate = useCallback(() => issue("generate"), [issue]);

  /** Replaces the existing credential, invalidating the previous one. Fails if there is none. */
  const rotate = useCallback(() => issue("rotate"), [issue]);

  const revoke = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetch(endpoint, { method: "DELETE" });
      if (!response.ok) {
        setFailure(await readApiError(response, "Could not revoke the key."));
        return;
      }
      setHasKey(false);
      setPlaintext(null);
    } catch (err) {
      fail(err, "Could not revoke the key.");
    } finally {
      setBusy(false);
    }
  }, [endpoint]);

  /** Hides the revealed plaintext. It is not recoverable afterwards — only rotation shows a new one. */
  const dismissPlaintext = useCallback(() => setPlaintext(null), []);

  return {
    enabled,
    hasKey,
    plaintext,
    extra,
    busy,
    loading: resource.loading,
    loadError: resource.error,
    reload: resource.reload,
    error: failure?.error ?? null,
    failure,
    toggle,
    generate,
    rotate,
    revoke,
    dismissPlaintext,
  };
}
