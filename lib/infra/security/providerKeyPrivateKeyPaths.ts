// The private key that opens provider keys. Only llm-proxy and vault-init set this: the app must never.
import path from "path";

export const PROVIDER_PRIVATE_KEY_FILE =
  process.env.PAODO_PROVIDER_PRIVATE_KEY_FILE ?? path.resolve(process.cwd(), ".paodo-provider-key", "private.pem");
