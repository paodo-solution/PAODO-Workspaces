// Home block for a workspace's API access: toggle, generate, rotate, revoke. Shares useCredential and
// CredentialPanel with the MCP block.
"use client";

import CopyField from "@/components/shared/CopyField";
import CredentialPanel from "@/components/shared/CredentialPanel";
import { useCredential } from "@/lib/client/hooks/useCredential";

// Module scope, not an inline literal: the options object is a dependency of the hook's callbacks, so
// a fresh one each render would rebuild them every time.
const LABELS = { feature: "API access" };
const OPTIONS = { accessField: "workspaceApiAccess", keyField: "workspaceApiKey" } as const;

export default function ApiAccessBlock({ wsId }: { wsId: string }) {
  const endpoint = `/api/workspaces/${wsId}/api-key`;
  const credential = useCredential<{ publicBaseUrl: string | null }>(endpoint, LABELS, OPTIONS);

  // The agent endpoint is published on the DNS-direct public host when one is configured; otherwise
  // show the origin the user is already on rather than a URL that would not resolve for them.
  const origin = credential.extra?.publicBaseUrl ?? (typeof window !== "undefined" ? window.location.origin : "");
  const url = `${origin}/api/workspaces/${wsId}/agent`;

  return (
    <CredentialPanel
      title="Workspace API access"
      toggleLabel="API access"
      description="Lets external clients start agent runs for this workspace with a dedicated bearer key."
      enabled={credential.enabled}
      hasKey={credential.hasKey}
      plaintext={credential.plaintext}
      busy={credential.busy}
      error={credential.error}
      loading={credential.loading}
      loadError={credential.loadError}
      onRetry={credential.reload}
      onToggle={credential.toggle}
      onGenerate={credential.generate}
      onRotate={credential.rotate}
      onRevoke={credential.revoke}
      onDismissPlaintext={credential.dismissPlaintext}
    >
      {(credential.hasKey || credential.plaintext) && <CopyField label="API endpoint" value={url} />}
    </CredentialPanel>
  );
}
