import { cn } from "@/lib/utils";

/** Eenvoudige meter (0..100). Kleurt oranje vanaf 75% en rood vanaf 90%. */
export function Progress({ value, className, label }: { value: number | null; className?: string; label?: string }) {
  const v = value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value));
  const color = v >= 90 ? "bg-destructive" : v >= 75 ? "bg-warning" : "bg-primary";
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v)}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500", color)} style={{ width: `${v}%` }} />
    </div>
  );
}
