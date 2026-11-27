"use client";
import { ChartLine } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { StatsHistory, StatsRange } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { formatBytes, formatPct } from "@/app/_lib/format";
import { intlLocale, useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";
import { niceBytes, niceCeil, summarize } from "./chart-math";
import { SeriesSwatch, UsageChart, type ChartSeries } from "./usage-chart";

export const RANGES: StatsRange[] = ["1h", "24h", "7d", "30d"];
const RANGE_KEY = "panel_stats_range";
const TZ = "Europe/Amsterdam";

function readRange(): StatsRange {
  try {
    const v = localStorage.getItem(RANGE_KEY);
    return RANGES.includes(v as StatsRange) ? (v as StatsRange) : "24h";
  } catch {
    return "24h";
  }
}

function dateFmt(opts: Intl.DateTimeFormatOptions) {
  const f = new Intl.DateTimeFormat(intlLocale(), { timeZone: TZ, ...opts });
  return (d: Date) => f.format(d);
}

const perSec = (v: number) => `${formatBytes(v)}/s`;

/** Tabblad "Statistieken": CPU, geheugen, schijf en netwerk over een gekozen periode. */
export function StatsView({ uuid }: { uuid: string }) {
  const t = useT();
  const [range, setRange] = useState<StatsRange>("24h");
  useEffect(() => setRange(readRange()), []);
  const pick = (r: StatsRange) => {
    setRange(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      /* alleen een gemak */
    }
  };
  const q = trpc.servers.statsHistory.useQuery(
    { uuid, range },
    { refetchInterval: range === "1h" || range === "24h" ? 60_000 : 300_000, placeholderData: (prev) => prev, retry: false },
  );

  return (
    <div className="space-y-4" data-testid="stats-view">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">{t.stats.title}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t.stats.description}</p>
        </div>
        <div role="group" aria-label={t.stats.rangeLabel} className="inline-flex rounded-lg border border-input bg-card/40 p-0.5" data-testid="stats-range">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => pick(r)}
              className={cn("h-10 rounded-md px-3 text-sm font-medium transition-colors md:h-8", range === r ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {t.stats.ranges[r]}
            </button>
          ))}
        </div>
      </div>
      {q.error ? (
        <QueryError error={q.error} />
      ) : !q.data ? (
        <div className="grid gap-4 lg:grid-cols-2" data-testid="stats-loading">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-64 rounded-2xl" />
          ))}
        </div>
      ) : q.data.points.every((p) => p.cpuPct === null) ? (
        <Card data-testid="stats-empty">
          <EmptyState icon={ChartLine} title={t.stats.emptyTitle}>
            {t.stats.emptyText}
          </EmptyState>
        </Card>
      ) : (
        <Charts data={q.data} stale={q.isPlaceholderData} />
      )}
    </div>
  );
}

function Charts({ data, stale }: { data: StatsHistory; stale: boolean }) {
  const t = useT();
  const [hover, setHover] = useState<number | null>(null);
  const long = data.range === "7d" || data.range === "30d";
  const fmt = {
    tick: long ? dateFmt({ day: "numeric", month: "short" }) : dateFmt({ hour: "2-digit", minute: "2-digit" }),
    title: data.range === "1h" ? dateFmt({ hour: "2-digit", minute: "2-digit" }) : dateFmt({ weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
  };
  const times = data.points.map((p) => p.t);
  const col = <K extends keyof (typeof data.points)[number]>(k: K) => data.points.map((p) => p[k] as number | null);
  const cpu = col("cpuPct");
  const cpuMax = col("cpuMaxPct");
  const mem = col("memoryBytes");
  const memMax = col("memoryMaxBytes");
  const disk = col("diskBytes");
  const rx = col("rxBytesPerSec");
  const tx = col("txBytesPerSec");
  const sCpu = summarize(cpu, cpuMax);
  const sMem = summarize(mem, memMax);
  const sDisk = summarize(disk);
  const sRx = summarize(rx);
  const sTx = summarize(tx);
  const aggregated = data.stepSeconds > 60;

  const cpuTop = data.cpuLimitPct > 0 ? Math.max(data.cpuLimitPct, niceCeil(sCpu?.peak ?? 0, 10)) : niceCeil((sCpu?.peak ?? 0) * 1.15, 10);
  const memTop = data.memoryLimitBytes > 0 ? Math.max(data.memoryLimitBytes, sMem?.peak ?? 0) : niceBytes((sMem?.peak ?? 0) * 1.15);
  const diskTop = niceBytes(Math.max(sDisk?.peak ?? 0, 1) * 1.15);
  const netTop = niceBytes(Math.max(sRx?.peak ?? 0, sTx?.peak ?? 0, 1) * 1.15);

  const peakRow = (values: (number | null)[], f: (v: number) => string) => (i: number) =>
    aggregated && values[i] != null ? (
      <div className="mt-0.5 flex justify-between gap-4 text-muted-foreground">
        <span>{t.stats.peak}</span>
        <span className="tabular-nums">{f(values[i]!)}</span>
      </div>
    ) : null;

  const common = { times, hover, onHover: setHover, formatTick: fmt.tick, tooltipTitle: fmt.title, noDataLabel: t.stats.noData };
  const primary = (key: string, label: string, values: (number | null)[]): ChartSeries[] => [{ key, label, color: "var(--primary)", values }];
  const sum = (s: ReturnType<typeof summarize>, f: (v: number) => string) => (s ? t.stats.summary(f(s.avg), f(s.peak)) : "–");

  return (
    <div className={cn("space-y-4 transition-opacity", stale && "opacity-60")}>
      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title={t.stats.cpu} value={sCpu ? formatPct(sCpu.last) : "–"} summary={sum(sCpu, formatPct)}>
          <UsageChart
            {...common}
            label={`${t.stats.cpu}: ${sum(sCpu, formatPct)}`}
            series={primary("cpu", t.stats.cpu, cpu)}
            yMax={cpuTop}
            format={(v) => formatPct(v)}
            limit={data.cpuLimitPct || null}
            limitLabel={data.cpuLimitPct ? t.stats.limit(formatPct(data.cpuLimitPct)) : undefined}
            tooltipExtra={peakRow(cpuMax, formatPct)}
          />
        </ChartCard>
        <ChartCard title={t.stats.memory} value={sMem ? formatBytes(sMem.last) : "–"} summary={sum(sMem, formatBytes)}>
          <UsageChart
            {...common}
            label={`${t.stats.memory}: ${sum(sMem, formatBytes)}`}
            series={primary("mem", t.stats.memory, mem)}
            yMax={memTop}
            format={formatBytes}
            limit={data.memoryLimitBytes || null}
            limitLabel={data.memoryLimitBytes ? t.stats.limit(formatBytes(data.memoryLimitBytes)) : undefined}
            tooltipExtra={peakRow(memMax, formatBytes)}
          />
        </ChartCard>
        <ChartCard title={t.stats.disk} value={sDisk ? formatBytes(sDisk.last) : "–"} summary={data.diskLimitBytes ? t.stats.limit(formatBytes(data.diskLimitBytes)) : t.common.unlimited}>
          <UsageChart
            {...common}
            label={`${t.stats.disk}: ${sDisk ? formatBytes(sDisk.last) : "–"}`}
            series={primary("disk", t.stats.disk, disk)}
            yMax={data.diskLimitBytes && data.diskLimitBytes <= diskTop ? data.diskLimitBytes : diskTop}
            format={formatBytes}
            limit={data.diskLimitBytes || null}
            limitLabel={data.diskLimitBytes ? t.stats.limit(formatBytes(data.diskLimitBytes)) : undefined}
          />
        </ChartCard>
        <ChartCard
          title={t.stats.network}
          value={
            <span className="flex flex-wrap gap-x-3">
              <Legend color="var(--primary)" label={t.stats.rx} value={sRx ? perSec(sRx.last) : "–"} />
              <Legend color="var(--chart-2)" dashed label={t.stats.tx} value={sTx ? perSec(sTx.last) : "–"} />
            </span>
          }
          summary={`${t.stats.avg} ${sRx ? perSec(sRx.avg) : "–"} / ${sTx ? perSec(sTx.avg) : "–"}`}
        >
          <UsageChart
            {...common}
            label={`${t.stats.network}: ${t.stats.rx} ${sum(sRx, perSec)}, ${t.stats.tx} ${sum(sTx, perSec)}`}
            series={[
              { key: "rx", label: t.stats.rx, color: "var(--primary)", values: rx },
              { key: "tx", label: t.stats.tx, color: "var(--chart-2)", values: tx, dashed: true },
            ]}
            yMax={netTop}
            format={perSec}
          />
        </ChartCard>
      </div>
      <p className="text-xs text-muted-foreground">{t.stats.gaps}</p>
      <details className="group rounded-xl border border-border bg-card/40 text-sm">
        <summary className="cursor-pointer select-none px-4 py-3 font-medium">{t.stats.showTable}</summary>
        <div className="max-h-96 overflow-auto border-t border-border">
          <table className="w-full text-left text-xs tabular-nums" data-testid="stats-table">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                {[t.stats.time, t.stats.cpu, t.stats.memory, t.stats.disk, `${t.stats.network} ${t.stats.rx}`, `${t.stats.network} ${t.stats.tx}`].map((h) => (
                  <th key={h} className="px-4 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.points
                .map((p, i) => ({ p, i }))
                .filter(({ p }) => p.cpuPct !== null)
                .reverse()
                .map(({ p, i }) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-4 py-1.5">{fmt.title(p.t)}</td>
                    <td className="px-4 py-1.5">{formatPct(p.cpuPct)}</td>
                    <td className="px-4 py-1.5">{formatBytes(p.memoryBytes)}</td>
                    <td className="px-4 py-1.5">{formatBytes(p.diskBytes)}</td>
                    <td className="px-4 py-1.5">{p.rxBytesPerSec == null ? "–" : perSec(p.rxBytesPerSec)}</td>
                    <td className="px-4 py-1.5">{p.txBytesPerSec == null ? "–" : perSec(p.txBytesPerSec)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function ChartCard({ title, value, summary, children }: { title: string; value: ReactNode; summary: string; children: ReactNode }) {
  return (
    <Card className="min-w-0 space-y-3 p-4 sm:p-5" data-testid="chart-card">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{summary}</div>
      </div>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      {children}
    </Card>
  );
}

function Legend({ color, label, value, dashed }: { color: string; label: string; value: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <SeriesSwatch color={color} dashed={dashed} />
      <span className="text-sm font-normal text-muted-foreground">{label}</span>
      <span>{value}</span>
    </span>
  );
}
