// Confirmation for rotating or revoking an access key (workspace API, workspace MCP, CLI access).
"use client";

import ConfirmModal from "./ConfirmModal";

export type CredentialAction = "rotate" | "revoke";

const COPY: Record<CredentialAction, { title: string; body: string; confirm: string; busy: string }> = {
  rotate: {
    title: "Rotate key",
    body: "The current key stops working right away. Every client using it must be updated with the new key.",
    confirm: "Rotate",
    busy: "Rotating…",
  },
  revoke: {
    title: "Revoke key",
    body: "The key stops working right away, and every client using it loses access. This can't be undone.",
    confirm: "Revoke",
    busy: "Revoking…",
  },
};

interface CredentialConfirmProps {
  action: CredentialAction;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export default function CredentialConfirm({ action, busy, onConfirm, onCancel }: CredentialConfirmProps) {
  const copy = COPY[action];
  return (
    <ConfirmModal
      title={copy.title}
      confirmLabel={copy.confirm}
      busyLabel={copy.busy}
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {copy.body}
    </ConfirmModal>
  );
}
