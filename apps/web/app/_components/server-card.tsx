"use client";
import { Gamepad2, Globe, Moon, Play } from "lucide-react";
import Link from "next/link";
import type { ServerSummary } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { ImageUpdateBadge } from "@/app/_components/image-updates";
import { StatusBadge } from "@/app/_components/status-badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Spinner } from "@/app/_components/ui/spinner";
import { UsageMeter } from "@/app/_components/usage-meter";
import { displayName } from "@/app/_components/user-avatar";
import { formatBytes, formatCpuLimit, formatMb, formatPct, isRunning, usagePct } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

export function ServerCard({ server }: { server: ServerSummary }) {
  const t = useT();
  const running = isRunning(server.status);
  const stats = trpc.servers.stats.useQuery({ uuid: server.uuid }, { enabled: running, refetchInterval: running ? 10_000 : false, retry: false });
  const s = running ? stats.data : null;
  const utils = trpc.useUtils();
  const start = trpc.servers.power.useMutation({ onSettled: () => void utils.servers.list.invalidate() });
  const Icon = server.type === "web" ? Globe : Gamepad2;
  const ramLimit = server.limits.ramMb * 1024 * 1024;
  const diskLimit = server.limits.diskMb * 1024 * 1024;

  return (
    <Card className="group relative flex flex-col gap-4 p-5 transition-colors hover:border-foreground/20" data-testid="server-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Icon className="size-5" />
          </span>
          <div className="min-w-0">
            <Link href={`/servers/${server.uuid}`} className="block truncate font-semibold after:absolute after:inset-0 after:content-['']">
              {server.name}
            </Link>
            <p className="truncate text-xs text-muted-foreground">
              {server.templateName} · {server.nodeName}
              {!server.isOwner && <> · {t.server.of(displayName(server.owner))}</>}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusBadge status={server.status} />
          <ImageUpdateBadge info={server.imageUpdate} />
        </div>
      </div>

      <div className="flex min-h-7 items-center gap-1 text-sm">
        {server.primaryAddress ? (
          <>
            <code className="truncate font-mono text-muted-foreground">{server.primaryAddress}</code>
            <CopyButton value={server.primaryAddress} label={t.server.copyAddress} className="relative z-10" />
          </>
        ) : (
          <span className="text-muted-foreground">{t.server.noAddress}</span>
        )}
      </div>

      <div className="grid gap-3">
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
      {!running && <p className="sr-only">{t.server.cpuLimitSr(formatCpuLimit(server.limits.cpuPct))}</p>}
      {server.status === "sleeping" && (
        <div className="relative z-10 flex items-center justify-between gap-2 rounded-md border border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200" data-testid="sleeping-hint">
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
