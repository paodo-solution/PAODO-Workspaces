// Helpers for the VS Code device routes: which device a request comes from, and the API origin to hand it.
import { validateDeviceAccess } from "@/lib/infra/security/credentialStore";
import { publicBaseUrl } from "@/lib/api/credentialRoutes";

// The gate already accepted the token for this route; reading it again here is what names the device.
export function deviceIdFromRequest(request: Request): string | null {
  const plain = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  return plain ? validateDeviceAccess(plain) : null;
}

// Where VS Code sends every call: the API host, which no SSO sits in front of. Without one (local dev,
// basic mode) it is the origin the browser used, whose Host the gate has already checked.
export function deviceApiUrl(headers: { get(name: string): string | null }): string {
  const configured = publicBaseUrl();
  if (configured) return configured;
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  return `${proto}://${headers.get("host") ?? "localhost"}`;
}
