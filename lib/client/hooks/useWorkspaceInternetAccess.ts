// Loads and changes a workspace's internet access and domain allowlist. A failed read is an `error`, never
// "off"; every change is optimistic and rolls back on rejection. Shared by InternetAccessBlock and EnvVarsBlock.
"use client";

import { useState, useCallback, useMemo, useRef } from "react";
import { confirmedValues, type WorkspaceUpdateReceipt } from "@/lib/client/workspaceReceipt";
import { fetchJson } from "@/lib/client/fetchJson";
import type { DomainAllowlist } from "@/lib/workspace/types";
import { useAsyncResource } from "./useAsyncResource";

interface Access {
  enabled: boolean;
  domainRestriction: boolean;
  allowedDomains: string[];
}

const NO_ACCESS: Access = { enabled: false, domainRestriction: false, allowedDomains: [] };

/** One PATCH body. Domains go as add/remove, so an edit never overwrites one another client just saved. */
export interface AccessChange {
  enabled?: boolean;
  domainRestriction?: boolean;
  addAllowedDomains?: string[];
  removeAllowedDomains?: string[];
}

interface PendingEdit {
  seq: number;
  change: AccessChange;
}

/** The change applied locally, the way the server merges it: removals drop out, additions go last. */
export function applyChange(access: Access, change: AccessChange): Access {
  const { addAllowedDomains: add = [], removeAllowedDomains: remove = [], ...flags } = change;
  const kept = access.allowedDomains.filter((domain) => !remove.includes(domain));
  return { ...access, ...flags, allowedDomains: [...kept, ...add.filter((domain) => !kept.includes(domain))] };
}

/** The server-confirmed state plus the edits still awaiting an answer, tagged with the load they apply to. */
export interface AccessEdits {
  id: string;
  source: Access | null;
  confirmed: Access;
  pending: PendingEdit[];
}

/** What the UI shows: the confirmed state with every unanswered edit applied in order. */
export function shownAccess(edits: Pick<AccessEdits, "confirmed" | "pending">): Access {
  return edits.pending.reduce<Access>((access, edit) => applyChange(access, edit.change), edits.confirmed);
}

// Settles edit `seq`: an applied one joins the confirmed state, the server's reported values winning; a
// rejected one (null) is dropped alone.
export function settleEdit(edits: AccessEdits, seq: number, applied: Partial<Access> | null): AccessEdits {
  const edit = edits.pending.find((pending) => pending.seq === seq);
  return {
    ...edits,
    confirmed: applied && edit ? { ...applyChange(edits.confirmed, edit.change), ...applied } : edits.confirmed,
    pending: edits.pending.filter((pending) => pending.seq !== seq),
  };
}

/** Runs tasks one at a time in call order, so whole-list saves reach the server in the order they were made. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  };
}

// Only what the receipt reports; settleEdit fills the rest from the change itself.
function appliedAccess(receipt: WorkspaceUpdateReceipt["applied"]): Partial<Access> {
  return {
    ...(receipt.internetAccess !== undefined ? { enabled: receipt.internetAccess } : {}),
    ...(receipt.domainRestriction !== undefined ? { domainRestriction: receipt.domainRestriction } : {}),
    ...(receipt.allowedDomains !== undefined ? { allowedDomains: receipt.allowedDomains } : {}),
  };
}

/** The applied values, or null when the server refused the change or could not be reached. */
export async function sendAccessChange(workspaceId: string, change: AccessChange): Promise<Partial<Access> | null> {
  try {
    const res = await fetch(`/api/workspaces/${workspaceId}/internet-access`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(change),
    });
    if (!res.ok) return null;
    return appliedAccess(await confirmedValues(res));
  } catch {
    return null;
  }
}

export function useWorkspaceInternetAccess(workspaceId: string | null) {
  const resource = useAsyncResource<Access>(
    useCallback(
      (signal) =>
        fetchJson<Access>(`/api/workspaces/${workspaceId}/internet-access`, signal, "Failed to load internet access."),
      [workspaceId],
    ),
    { enabled: workspaceId !== null },
  );

  // Tagged with both the workspace and the load it was made against (resource.data identity), so a
  // reload of the server value supersedes stale local edits instead of masking them.
  const [edits, setEdits] = useState<AccessEdits | null>(null);
  const serverAccess = useMemo<Access>(() => ({ ...NO_ACCESS, ...resource.data }), [resource.data]);
  const current = edits && edits.id === workspaceId && edits.source === resource.data ? edits : null;
  const access = useMemo<Access>(() => (current ? shownAccess(current) : serverAccess), [current, serverAccess]);

  const enqueue = useMemo(() => createSerialQueue(), []);
  const nextSeq = useRef(0);

  // Optimistic: the change renders immediately; a rejected one is removed without undoing edits made after it.
  const change = useCallback(
    async (change: AccessChange) => {
      if (!workspaceId) return;
      const seq = ++nextSeq.current;
      const source = resource.data;
      const sameLoad = (e: AccessEdits | null): e is AccessEdits => e?.id === workspaceId && e.source === source;
      setEdits((prev) => {
        const base = sameLoad(prev) ? prev : { id: workspaceId, source, confirmed: serverAccess, pending: [] };
        return { ...base, pending: [...base.pending, { seq, change }] };
      });
      const applied = await enqueue(() => sendAccessChange(workspaceId, change));
      setEdits((prev) => (sameLoad(prev) ? settleEdit(prev, seq, applied) : prev));
    },
    [workspaceId, resource.data, serverAccess, enqueue],
  );

  const toggle = useCallback(() => change({ enabled: !access.enabled }), [change, access.enabled]);
  const toggleDomainRestriction = useCallback(
    () => change({ domainRestriction: !access.domainRestriction }),
    [change, access.domainRestriction],
  );
  const addAllowedDomain = useCallback((domain: string) => change({ addAllowedDomains: [domain] }), [change]);
  const removeAllowedDomain = useCallback((domain: string) => change({ removeAllowedDomains: [domain] }), [change]);
  const allowlist = useMemo<DomainAllowlist>(
    () => ({ restricted: access.domainRestriction, domains: access.allowedDomains }),
    [access.domainRestriction, access.allowedDomains],
  );

  return {
    enabled: access.enabled,
    allowlist,
    loading: resource.loading,
    error: resource.error,
    reload: resource.reload,
    toggle,
    toggleDomainRestriction,
    addAllowedDomain,
    removeAllowedDomain,
  };
}
