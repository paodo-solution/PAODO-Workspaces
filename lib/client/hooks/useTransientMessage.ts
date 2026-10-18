// A message that clears itself `ms` after being set; a new message restarts the timer.
// Usage: const [error, setError] = useTransientMessage(2000);

import { useEffect, useState } from "react";

export function useTransientMessage(ms: number) {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (message === null) return;
    const timer = window.setTimeout(() => setMessage(null), ms);
    return () => window.clearTimeout(timer);
  }, [message, ms]);

  return [message, setMessage] as const;
}
