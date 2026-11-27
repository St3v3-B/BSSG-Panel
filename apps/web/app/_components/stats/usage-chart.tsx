"use client";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { buildPath, indexAt } from "./chart-math";

const W = 1000;
const H = 100;

export interface ChartSeries {
  key: string;
  label: string;
  /** CSS-kleur, bv. `var(--primary)`. */
  color: string;
  values: (number | null)[];
  /** Tweede codering naast kleur (voor kleurenblinden en print). */
  dashed?: boolean;
}

/**
 * Lijn-/vlakgrafiek met gaten, recessief raster, limietlijn, crosshair en tooltip.
 * De SVG schaalt mee (`preserveAspectRatio="none"`, lijnen met vaste dikte); tekst, punten en
 * tooltip zijn HTML, zodat ze nooit vervormen. De hover-index komt van de ouder, zodat
 * meerdere grafieken samen meebewegen.
 */
export function UsageChart({
  label,
  times,
  series,
  yMax,
  format,
  formatTick,
  limit,
  limitLabel,
  hover,
  onHover,
  tooltipTitle,
  tooltipExtra,
  noDataLabel,
  className,
}: {
  label: string;
  times: Date[];
  series: ChartSeries[];
  yMax: number;
  format: (v: number) => string;
  /** Label onder de x-as per index. */
  formatTick: (d: Date) => string;
  limit?: number | null;
  limitLabel?: string;
  hover: number | null;
  onHover: (i: number | null) => void;
  tooltipTitle: (d: Date) => string;
  /** Extra regel(s) in de tooltip, bv. de piek binnen de stap. */
  tooltipExtra?: (i: number) => ReactNode;
  noDataLabel: string;
  className?: string;
}) {
  const id = useId().replace(/:/g, "");
  const box = useRef<HTMLDivElement>(null);
  const n = times.length;
  const xPct = (i: number) => ((i + 0.5) / n) * 100;
  const yPct = (v: number) => 100 - Math.min(1, Math.max(0, v / yMax)) * 100;
  const single = series.length === 1;
  const ticks = n > 1 ? [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1] : [0];
  const showLimit = limit != null && limit > 0 && limit <= yMax;

  const move = (clientX: number) => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    onHover(indexAt(clientX, r.left, r.width, n));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const d = e.key === "ArrowLeft" ? -1 : 1;
      onHover(Math.max(0, Math.min(n - 1, (hover ?? n - 1) + (hover === null ? 0 : d))));
    } else if (e.key === "Escape") onHover(null);
  };

  const hv = hover !== null && hover >= 0 && hover < n ? hover : null;
  const flip = hv !== null && xPct(hv) > 60;
  return (
    <div className={cn("select-none", className)}>
      <div
          ref={box}
          role="img"
          aria-label={label}
          tabIndex={0}
          className="relative h-40 flex-1 touch-pan-y rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:h-44"
          onPointerMove={(e) => move(e.clientX)}
          onPointerDown={(e) => move(e.clientX)}
          onPointerLeave={(e) => e.pointerType === "mouse" && onHover(null)}
          onBlur={() => onHover(null)}
          onKeyDown={onKey}
          data-testid="usage-chart"
        >
          {/* raster: 0, de helft en de top */}
          {[0, 0.5, 1].map((f) => (
            <div key={f} aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-border" style={{ top: `${100 - f * 100}%`, borderStyle: f === 0 ? "solid" : "dashed" }}>
              {f > 0 && <span className="absolute left-0 top-0.5 text-[10px] leading-none tabular-nums text-muted-foreground">{format(yMax * f)}</span>}
            </div>
          ))}
          {showLimit && (
            <div aria-hidden className="pointer-events-none absolute inset-x-0 border-t border-dashed border-destructive/50" style={{ top: `${yPct(limit)}%` }}>
              {limitLabel && <span className="absolute right-0 -top-3.5 text-[10px] leading-none text-muted-foreground">{limitLabel}</span>}
            </div>
          )}
          <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
            <defs>
              {series.map((s) => (
                <linearGradient key={s.key} id={`g-${id}-${s.key}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            {single && <path d={buildPath(series[0]!.values, yMax, W, H, true)} fill={`url(#g-${id}-${series[0]!.key})`} />}
            {series.map((s) => (
              <path
                key={s.key}
                d={buildPath(s.values, yMax, W, H)}
                fill="none"
                stroke={s.color}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
                strokeDasharray={s.dashed ? "5 4" : undefined}
                vectorEffect="non-scaling-stroke"
                data-series={s.key}
              />
            ))}
          </svg>
          {hv !== null && (
            <>
              <div aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-foreground/30" style={{ left: `${xPct(hv)}%` }} />
              {series.map((s) =>
                s.values[hv] == null ? null : (
                  <span
                    key={s.key}
                    aria-hidden
                    className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
                    style={{ left: `${xPct(hv)}%`, top: `${yPct(s.values[hv]!)}%`, background: s.color }}
                  />
                ),
              )}
              <div
                role="tooltip"
                className={cn("pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border border-border bg-popover/95 px-3 py-2 text-xs shadow-pop backdrop-blur", flip ? "-translate-x-[calc(100%+10px)]" : "translate-x-2.5")}
                style={{ left: `${xPct(hv)}%` }}
                data-testid="chart-tooltip"
              >
                <div className="mb-1 font-medium text-popover-foreground">{tooltipTitle(times[hv]!)}</div>
                {series.every((s) => s.values[hv] == null) ? (
                  <div className="text-muted-foreground">{noDataLabel}</div>
                ) : (
                  series.map((s) => (
                    <div key={s.key} className="flex items-center justify-between gap-4">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <SeriesSwatch color={s.color} dashed={s.dashed} />
                        {s.label}
                      </span>
                      <span className="whitespace-nowrap tabular-nums text-popover-foreground">{s.values[hv] == null ? "–" : format(s.values[hv]!)}</span>
                    </div>
                  ))
                )}
                {tooltipExtra?.(hv)}
              </div>
            </>
          )}
      </div>
      <div aria-hidden className="relative mt-1.5 h-4 text-[10px] tabular-nums text-muted-foreground">
        {ticks.map((i, k) => (
          <span key={k} className={cn("absolute whitespace-nowrap", k === 0 ? "" : k === ticks.length - 1 ? "-translate-x-full" : "-translate-x-1/2")} style={{ left: k === 0 ? 0 : k === ticks.length - 1 ? "100%" : `${xPct(i)}%` }}>
            {times[i] ? formatTick(times[i]!) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Lijnstukje in de kleur (en het streepjespatroon) van een reeks, voor legenda en tooltip. */
export function SeriesSwatch({ color, dashed }: { color: string; dashed?: boolean }) {
  return (
    <svg aria-hidden width="14" height="4" className="shrink-0">
      <line x1="1" y1="2" x2="13" y2="2" stroke={color} strokeWidth="2" strokeLinecap="round" strokeDasharray={dashed ? "3 3" : undefined} />
    </svg>
  );
}

/** Kleine lijn zonder assen, voor de serverkaarten. */
export function Sparkline({ values, yMax, label, className }: { values: (number | null)[]; yMax: number; label: string; className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={label} className={cn("block h-8 w-full overflow-visible", className)} data-testid="sparkline">
      <defs>
        <linearGradient id={`s-${id}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.3} />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={buildPath(values, yMax, W, H, true)} fill={`url(#s-${id})`} />
      <path d={buildPath(values, yMax, W, H)} fill="none" stroke="var(--primary)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
