// Installs the expired-session reload at module load, before any component effect can fetch.
"use client";

import { installSessionGuard } from "@/lib/client/sessionGuard";

if (typeof window !== "undefined") installSessionGuard(window);

export default function SessionGuard() {
  return null;
}
