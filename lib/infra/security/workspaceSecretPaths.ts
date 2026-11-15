import path from "path";

export const WORKSPACE_SECRET_VAULT_ROOT =
  process.env.PAODO_WORKSPACE_SECRET_VAULT_ROOT ?? path.resolve(process.cwd(), ".paodo-workspace-secret-vault");
