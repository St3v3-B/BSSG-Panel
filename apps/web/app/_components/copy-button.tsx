"use client";
import { Check, Copy } from "lucide-react";
import { Button } from "@/app/_components/ui/button";
import { useCopy } from "@/app/_hooks/use-copy";
import { cn } from "@/lib/utils";

export function CopyButton({ value, label = "Kopiëren", className }: { value: string; label?: string; className?: string }) {
  const { copied, copy } = useCopy();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn("size-7 text-muted-foreground", className)}
      aria-label={copied ? "Gekopieerd" : label}
      title={copied ? "Gekopieerd" : label}
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
      <CopyButton value={value} label={`${value} kopiëren`} />
    </span>
  );
}
