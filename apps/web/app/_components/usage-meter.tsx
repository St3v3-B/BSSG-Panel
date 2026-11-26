import { Progress } from "@/app/_components/ui/progress";

export function UsageMeter({ label, value, detail, pct }: { label: string; value: string; detail?: string; pct: number | null }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {value}
          {detail && <span className="text-muted-foreground"> / {detail}</span>}
        </span>
      </div>
      <Progress value={pct} label={label} />
    </div>
  );
}
