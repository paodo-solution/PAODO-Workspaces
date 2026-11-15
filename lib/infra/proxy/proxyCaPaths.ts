import path from "path";

/** The credential proxy's CA, HMAC key and internet-access policy. Never inside the workspace data root. */
export const PROXY_CA_ROOT = process.env.PAODO_PROXY_CA_ROOT ?? path.resolve(process.cwd(), ".paodo-proxy-ca");
