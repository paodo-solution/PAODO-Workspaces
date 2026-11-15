import path from "path";

export const PROVIDER_VAULT_ROOT =
  process.env.PAODO_PROVIDER_VAULT_ROOT ?? path.resolve(process.cwd(), ".paodo-provider-vault");
