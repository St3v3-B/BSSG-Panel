import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function Spinner({ className, label = "Laden…" }: { className?: string; label?: string }) {
  return <LoaderCircle role="status" aria-label={label} className={cn("size-4 animate-spin", className)} />;
}
