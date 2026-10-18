// A workspace's conversations for the switcher. Selects (or creates) the newest on first load; refresh
// re-reads titles, order and `running` without changing the selection.
"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import type { Message } from "@/lib/transcript/message";

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  running: boolean;
}

// The newest conversation's full payload, delivered inline with the list on first load so the chat
// can render immediately — no separate fetch (see ChatPanel's fast path).
export interface InitialConversation {
  id: string;
  transcript: Message[];
  running: boolean;
  userInput: string | null;
}

export function useConversations(workspaceId: string) {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadNonce, setLoadNonce] = useState(0);
  const retry = useCallback(() => setLoadNonce((n) => n + 1), []);
  const [initial, setInitial] = useState<InitialConversation | null>(null);
  // Deep-link target (?conversation=<id>), e.g. from a call_agent "View session" link in another
  // workspace. When it names a real conversation we open it instead of the newest.
  const requestedConvId = useSearchParams().get("conversation");

  const refresh = useCallback(async (): Promise<ConversationMeta[]> => {
    const res = await fetch(`/api/workspaces/${workspaceId}/conversations`);
    if (!res.ok) return [];
    const { conversations } = (await res.json()) as { conversations: ConversationMeta[] };
    setConversations(conversations);
    return conversations;
  }, [workspaceId]);

  const create = useCallback(async (): Promise<string | null> => {
    const res = await fetch(`/api/workspaces/${workspaceId}/conversations`, { method: "POST" });
    if (!res.ok) return null;
    const { conversation } = (await res.json()) as { conversation: ConversationMeta };
    setConversations((prev) => [conversation, ...prev.filter((c) => c.id !== conversation.id)]);
    setActiveId(conversation.id);
    return conversation.id;
  }, [workspaceId]);

  // Picks the newest conversation (or creates one); `/conversations/initial` also returns its
  // transcript, saving a round-trip.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(false);
      setActiveId(null); // clear any selection carried over from a previous workspace
      setInitial(null);
      const res = await fetch(`/api/workspaces/${workspaceId}/conversations/initial`);
      if (cancelled) return;
      if (!res.ok) throw new Error("Failed to load conversations");
      const { conversations, active } = (await res.json()) as {
        conversations: ConversationMeta[];
        active: InitialConversation | null;
      };
      if (cancelled) return;
      setConversations(conversations);
      if (conversations.length === 0) {
        if (!(await create())) throw new Error("Failed to create conversation");
        return;
      }
      setInitial(active);
      // Honor a ?conversation= deep-link when it points at a real conversation; else newest.
      const requested = requestedConvId && conversations.some((c) => c.id === requestedConvId) ? requestedConvId : null;
      setActiveId(requested ?? conversations[0].id);
    })()
      .catch(() => {
        if (!cancelled) setLoadError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, create, requestedConvId, loadNonce]);

  // Polls the "running" dots only while a run is in flight (started by a running flag or `kick()`),
  // stopping on the first idle poll, so an idle workspace makes no requests.
  const anyRunning = conversations.some((c) => c.running);
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => {
      void refresh();
    }, 2500);
    return () => clearInterval(t);
  }, [anyRunning, refresh]);

  return { conversations, activeId, setActiveId, create, refresh, initial, loading, loadError, retry };
}
