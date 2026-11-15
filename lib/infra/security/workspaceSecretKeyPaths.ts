// The private key that opens workspace secrets. Only credproxy and vault-init set this: the app must never.
import path from "path";

export const WORKSPACE_SECRET_PRIVATE_KEY_FILE =
  process.env.PAODO_WORKSPACE_SECRET_KEY_FILE ??
  path.resolve(process.cwd(), ".paodo-workspace-secret-key", "private.pem");
