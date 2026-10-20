"use client";

import { useState } from "react";

/** Holds the action awaiting confirmation; `confirm` runs it and closes the dialog once it settles. */
export function useConfirm<T>(perform: (pending: T) => Promise<void>) {
  const [pending, setPending] = useState<T | null>(null);
  const confirm = async () => {
    if (pending === null) return;
    await perform(pending);
    setPending(null);
  };
  return { pending, ask: setPending, confirm, cancel: () => setPending(null) };
}
