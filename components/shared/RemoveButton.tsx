// The red "×" that removes a row (allowed domain, secret, secret domain) on its first click.
"use client";

export default function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="border-0 bg-transparent p-0 text-lg leading-none text-danger cursor-pointer hover:opacity-70 shrink-0"
      aria-label={label}
      onClick={onClick}
    >
      ×
    </button>
  );
}
