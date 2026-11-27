"use client";
import type { CSSProperties } from "react";
import { Gamepad2, Globe, Moon, Play } from "lucide-react";
import Link from "next/link";
import type { ServerSummary, StatsSparkline } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { ImageUpdateBadge } from "@/app/_components/image-updates";
import { powerAvailability } from "@/app/_components/power-buttons";
import { StatusBadge } from "@/app/_components/status-badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Spinner } from "@/app/_components/ui/spinner";
import { UsageMeter } from "@/app/_components/usage-meter";
import { niceCeil } from "@/app/_components/stats/chart-math";
import { Sparkline } from "@/app/_components/stats/usage-chart";
import { displayName } from "@/app/_components/user-avatar";
import { formatBytes, formatCpuLimit, formatMb, formatPct, isRunning, usagePct } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { applyOptimisticPower } from "@/app/_lib/optimistic-power";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<ServerSummary["status"], string> = {
  installing: "var(--info)",
  install_failed: "var(--destructive)",
  offline: "var(--muted-foreground)",
  starting: "var(--warning)",
  online: "var(--success)",
  stopping: "var(--warning)",
  disk_exceeded: "var(--destructive)",
  sleeping: "oklch(0.7 0.14 275)",
  unknown: "var(--muted-foreground)",
};

export function ServerCard({ server, sparkline }: { server: ServerSummary; sparkline?: StatsSparkline }) {
  const t = useT();
  const running = isRunning(server.status);
  const stats = trpc.servers.stats.useQuery({ uuid: server.uuid }, { enabled: running, refetchInterval: running ? 10_000 : false, retry: false });
  const s = running ? stats.data : null;
  const utils = trpc.useUtils();
  const start = trpc.servers.power.useMutation({
    onMutate: ({ uuid, action }) => applyOptimisticPower(utils, uuid, action),
    onError: (_e, _v, rollback) => rollback?.(),
    onSettled: () => void utils.servers.list.invalidate(),
  });
  // Details alvast ophalen zodra de muis of het toetsenbord op de kaart komt: de serverpagina opent dan zonder skeleton.
  const prefetch = () => void utils.servers.get.prefetch({ uuid: server.uuid }, { staleTime: 10_000 });
  const Icon = server.type === "web" ? Globe : Gamepad2;
  const ramLimit = server.limits.ramMb * 1024 * 1024;
  const diskLimit = server.limits.diskMb * 1024 * 1024;

  const tone = STATUS_TONE[server.status];
  const canStart = server.isOwner && !server.suspended && powerAvailability(server.status).start && server.status !== "sleeping";
  return (
    <Card className="group relative flex flex-col gap-4 overflow-hidden p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-foreground/20 sm:p-5" data-testid="server-card" data-status={server.status} onMouseEnter={prefetch} onFocus={prefetch} onTouchStart={prefetch} style={{ "--tone": tone } as CSSProperties}>
      <span aria-hidden className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-[var(--tone)] to-transparent opacity-80" />
      <span aria-hidden className={cn("pointer-events-none absolute -right-10 -top-10 size-40 rounded-full bg-[var(--tone)] blur-3xl transition-opacity", running ? "opacity-20 group-hover:opacity-30" : "opacity-[0.07]")} />
      <div className="relative flex flex-wrap items-start justify-between gap-x-3 gap-y-2.5">
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-muted/70 text-[var(--tone)]">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <Link href={`/servers/${server.uuid}`} className="line-clamp-2 break-words text-base font-semibold leading-snug after:absolute after:inset-0 after:content-['']">
              {server.name}
            </Link>
            <p className="line-clamp-2 text-xs text-muted-foreground">
              {server.templateName} · {server.nodeName}
              {!server.isOwner && <> · {t.server.of(displayName(server.owner))}</>}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 max-sm:w-full sm:flex-col sm:items-end sm:gap-1">
          <StatusBadge status={server.status} lastSeenAt={server.lastSeenAt} />
          <ImageUpdateBadge info={server.imageUpdate} />
        </div>
      </div>

      <div className="relative flex min-h-9 items-center gap-1 rounded-lg border border-border bg-background/40 px-3 text-sm">
        {server.primaryAddress ? (
          <>
            <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-foreground/80">{server.primaryAddress}</code>
            <CopyButton value={server.primaryAddress} label={t.server.copyAddress} className="relative z-10" />
          </>
        ) : (
          <span className="text-muted-foreground">{t.server.noAddress}</span>
        )}
      </div>

      <div className="relative grid gap-3">
        {running && sparkline && sparkline.cpuPct.filter((v) => v !== null).length >= 2 && (
          <div className="-mb-1 space-y-1" data-testid="card-sparkline">
            <div className="text-[11px] text-muted-foreground">{t.stats.sparkLabel}</div>
            <Sparkline
              values={sparkline.cpuPct}
              yMax={niceCeil(Math.max(...sparkline.cpuPct.map((v) => v ?? 0)) * 1.15, 10)}
              label={t.stats.sparkLabel}
            />
          </div>
        )}
        <UsageMeter
          label={t.server.cpu}
          value={s ? formatPct(s.cpuPct) : "–"}
          detail={server.limits.cpuPct ? formatPct(server.limits.cpuPct) : t.common.unlimited}
          pct={s && server.limits.cpuPct ? usagePct(s.cpuPct, server.limits.cpuPct) : null}
        />
        <UsageMeter
          label={t.server.memory}
          value={s ? formatBytes(s.memoryBytes) : "–"}
          detail={formatMb(server.limits.ramMb)}
          pct={s ? usagePct(s.memoryBytes, s.memoryLimitBytes || ramLimit) : null}
        />
        <UsageMeter
          label={t.server.disk}
          value={s ? formatBytes(s.diskBytes) : "–"}
          detail={server.limits.diskMb ? formatMb(server.limits.diskMb) : t.common.unlimited}
          pct={s ? usagePct(s.diskBytes, s.diskLimitBytes || diskLimit) : null}
        />
      </div>
      {canStart && (
        <div className="relative z-10 -mb-1 flex">
          <Button size="sm" variant="secondary" className="w-full" disabled={start.isPending} onClick={() => start.mutate({ uuid: server.uuid, action: "start" })} data-testid="card-start">
            {start.isPending ? <Spinner /> : <Play />} {t.power.start}
          </Button>
        </div>
      )}
      {!running && <p className="sr-only">{t.server.cpuLimitSr(formatCpuLimit(server.limits.cpuPct))}</p>}
      {server.status === "sleeping" && (
        <div className="relative z-10 flex items-center justify-between gap-2 rounded-md border border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-700 dark:text-indigo-200" data-testid="sleeping-hint">
          <span className="flex items-center gap-1.5">
            <Moon className="size-3.5" /> {t.sleep.cardHint}
          </span>
          {server.isOwner && (
            <Button size="sm" variant="secondary" className="h-7" disabled={start.isPending} onClick={() => start.mutate({ uuid: server.uuid, action: "start" })}>
              {start.isPending ? <Spinner /> : <Play />} {t.power.start}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
