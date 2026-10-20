"use client";

import ConfirmModal from "@/components/shared/ConfirmModal";

interface ConfirmDeleteModalProps {
  name: string;
  deleting: boolean;
  onConfirm(): void;
  onCancel(): void;
}

export default function ConfirmDeleteModal({ name, deleting, onConfirm, onCancel }: ConfirmDeleteModalProps) {
  return (
    <ConfirmModal
      title="Delete workspace"
      confirmLabel="Delete"
      busyLabel="Deleting…"
      busy={deleting}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      This will permanently delete <b className="text-text">{name}</b>. This action can&apos;t be undone.
    </ConfirmModal>
  );
}
