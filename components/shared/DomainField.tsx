// A domain input that shows the format error once the user leaves it or presses Enter, and hides it while
// they edit. `children` sits beside the input (Save, ×). Blank input never shows the error.
"use client";

import { useState, type KeyboardEvent, type ReactNode } from "react";
import { DOMAIN_FORMAT_ERROR, isValidDomain } from "@/lib/workspace/domain";

interface DomainFieldProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  ariaLabel?: string;
  autoFocus?: boolean;
  children?: ReactNode;
}

export default function DomainField({
  value,
  onChange,
  onBlur,
  onKeyDown,
  ariaLabel,
  autoFocus,
  children,
}: DomainFieldProps) {
  const [touched, setTouched] = useState(false);
  const showError = touched && value.trim() !== "" && !isValidDomain(value);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          className="input input-sm font-mono flex-1"
          value={value}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          aria-invalid={showError}
          onChange={(e) => {
            setTouched(false);
            onChange(e.target.value);
          }}
          onBlur={() => {
            setTouched(true);
            onBlur?.();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") setTouched(true);
            onKeyDown?.(e);
          }}
        />
        {children}
      </div>
      {showError && <p className="text-xs text-danger m-0">{DOMAIN_FORMAT_ERROR}</p>}
    </div>
  );
}
