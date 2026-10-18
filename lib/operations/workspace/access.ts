// The workspace's inbound channels (API key, MCP key): open/closed lives here, keys in the credential routes.
// Egress doesn't gate them, so there's no `blockedBy`.
import { setEnabled, state, type CredentialState } from "@/lib/infra/security/credentialStore";
import { WorkspaceUpdateError } from "./errors";

export type AccessChannel = "workspace-api" | "workspace-mcp";

// Each channel reports enabled and hasKey separately, then its address, so a caller can tell closed
// from open-but-keyless.
export interface WorkspaceAccessDetails {
  workspaceApiAccess: boolean;
  workspaceApiHasKey: boolean;
  apiEndpoint: string;
  workspaceMcpAccess: boolean;
  workspaceMcpHasKey: boolean;
  mcpConnectionUrl: string;
}

type CredentialStateReader = (
  channel: AccessChannel,
  workspaceId: string,
) => Pick<CredentialState, "enabled" | "hasKey">;

/** The one credential operation a channel toggle needs. It never reads or writes the key itself. */
export interface ChannelCredentials {
  setEnabled(channel: AccessChannel, id: string, enabled: boolean): void;
}

// Deliberately a factory that forwards, not `{ setEnabled }` captured at module load: the direct
// binding resolves the import at init, which a partial test mock of credentialStore cannot replace.
function defaultChannelCredentials(): ChannelCredentials {
  return {
    setEnabled: (channel, id, enabled) => setEnabled(channel, id, enabled),
  };
}

export function validateChannelEnabled(field: string, value: unknown): boolean {
  if (typeof value !== "boolean") throw new WorkspaceUpdateError(`${field} must be true or false`);
  return value;
}

// Never exposes a credential. The address is always present, even before it works, since an operator
// needs it while setting an integration up.
export function getWorkspaceAccess(
  id: string,
  connectionOrigin: string,
  readCredentialState: CredentialStateReader = state,
): WorkspaceAccessDetails {
  const api = readCredentialState("workspace-api", id);
  const mcp = readCredentialState("workspace-mcp", id);
  const origin = connectionOrigin.replace(/\/+$/, "");
  const workspace = encodeURIComponent(id);

  return {
    workspaceApiAccess: api.enabled,
    workspaceApiHasKey: api.hasKey,
    apiEndpoint: `${origin}/api/workspaces/${workspace}/agent`,
    workspaceMcpAccess: mcp.enabled,
    workspaceMcpHasKey: mcp.hasKey,
    mcpConnectionUrl: `${origin}/api/workspaces/${workspace}/mcp`,
  };
}

// Only opens or closes; never mints, so the one-time plaintext goes only to a caller that asked for it.
// Toggling keeps existing keys across an off/on cycle.
export function setChannelEnabled(
  channel: AccessChannel,
  id: string,
  enabled: boolean,
  credentials: ChannelCredentials = defaultChannelCredentials(),
): void {
  credentials.setEnabled(channel, id, enabled);
}
