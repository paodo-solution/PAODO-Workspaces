// Runs an async action; `pending` turns true only after `delayMs`, so fast actions never flash a spinner.
// Re-entrant calls are ignored (ref guard). Usage: const { pending, run } = useDeferredPending();

import { useCallback, useRef, useState } from "react";

export function useDeferredPending(delayMs = 1000) {
  const [pending, setPending] = useState(false);
  const runningRef = useRef(false);

  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      if (runningRef.current) return undefined;
      runningRef.current = true;
      const timer = window.setTimeout(() => setPending(true), delayMs);
      try {
        return await action();
      } finally {
        clearTimeout(timer);
        runningRef.current = false;
        setPending(false);
      }
    },
    [delayMs],
  );

  return { pending, run };
}
