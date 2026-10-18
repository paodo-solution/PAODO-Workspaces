import { isLoopbackAddress } from "@/lib/infra/security/rateLimit";

// NextRequest sibling of security/httpAuth.ts getClientIp (see there for why only cf-connecting-ip).
// Loopback is refused since the limiter exempts it; with no socket to fall back on, it reports unknown.
export function getClientIp(req: Pick<Request, "headers">): string {
  const forwarded = req.headers.get("cf-connecting-ip")?.trim();
  if (!forwarded || isLoopbackAddress(forwarded)) return "unknown";
  return forwarded;
}
