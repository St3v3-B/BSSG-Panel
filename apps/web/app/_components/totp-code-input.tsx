"use client";
import { Input } from "@/app/_components/ui/input";
import { cn } from "@/lib/utils";

/** Invoerveld voor een 6-cijferige TOTP-code (alleen cijfers, autofill van authenticator-apps). */
export function TotpCodeInput({
  value,
  onChange,
  id = "totp-code",
  autoFocus,
  disabled,
  invalid,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  id?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  className?: string;
}) {
  return (
    <Input
      id={id}
      inputMode="numeric"
      autoComplete="one-time-code"
      pattern="\d{6}"
      maxLength={6}
      placeholder="123456"
      autoFocus={autoFocus}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      className={cn("h-11 text-center font-mono text-xl tracking-[0.5em]", className)}
    />
  );
}

export const isTotpCode = (v: string) => /^\d{6}$/.test(v);
