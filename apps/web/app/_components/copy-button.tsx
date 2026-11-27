"use client";
import { Check, Copy } from "lucide-react";
import { Button } from "@/app/_components/ui/button";
import { useCopy } from "@/app/_hooks/use-copy";
import { cn } from "@/lib/utils";
import { useT } from "@/app/_lib/i18n";

export function CopyButton({ value, label: labelProp, className }: { value: string; label?: string; className?: string }) {
  const t = useT();
  const label = labelProp ?? t.common.copy;
  const { copied, copy } = useCopy();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn("size-9 text-muted-foreground md:size-7", className)}
      aria-label={copied ? t.common.copied : label}
      title={copied ? t.common.copied : label}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void copy(value);
      }}
    >
      {copied ? <Check className="text-success" /> : <Copy />}
    </Button>
  );
}

/** Adres in monospace met kopieerknop. */
export function CopyText({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      <code className="font-mono text-sm">{value}</code>
      <CopyButton value={value} label={useT().common.copyX(value)} />
    </span>
  );
}
