"use client";
import { Gamepad2, Globe } from "lucide-react";
import Link from "next/link";
import type { ServerSummary } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { StatusBadge } from "@/app/_components/status-badge";
import { Card } from "@/app/_components/ui/card";
import { UsageMeter } from "@/app/_components/usage-meter";
import { displayName } from "@/app/_components/user-avatar";
import { formatBytes, formatCpuLimit, formatMb, formatPct, isRunning, usagePct } from "@/app/_lib/format";

export function ServerCard({ server }: { server: ServerSummary }) {
  const running = isRunning(server.status);
  const stats = trpc.servers.stats.useQuery({ uuid: server.uuid }, { enabled: running, refetchInterval: running ? 10_000 : false, retry: false });
  const s = running ? stats.data : null;
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
              {!server.isOwner && <> · van {displayName(server.owner)}</>}
            </p>
          </div>
        </div>
        <StatusBadge status={server.status} />
      </div>

      <div className="flex min-h-7 items-center gap-1 text-sm">
        {server.primaryAddress ? (
          <>
            <code className="truncate font-mono text-muted-foreground">{server.primaryAddress}</code>
            <CopyButton value={server.primaryAddress} label="Adres kopiëren" className="relative z-10" />
          </>
        ) : (
          <span className="text-muted-foreground">Geen adres</span>
        )}
      </div>

      <div className="grid gap-3">
        <UsageMeter
          label="CPU"
          value={s ? formatPct(s.cpuPct) : "–"}
          detail={server.limits.cpuPct ? formatPct(server.limits.cpuPct) : "onbeperkt"}
          pct={s && server.limits.cpuPct ? usagePct(s.cpuPct, server.limits.cpuPct) : null}
        />
        <UsageMeter
          label="Geheugen"
          value={s ? formatBytes(s.memoryBytes) : "–"}
          detail={formatMb(server.limits.ramMb)}
          pct={s ? usagePct(s.memoryBytes, s.memoryLimitBytes || ramLimit) : null}
        />
        <UsageMeter
          label="Schijf"
          value={s ? formatBytes(s.diskBytes) : "–"}
          detail={server.limits.diskMb ? formatMb(server.limits.diskMb) : "onbeperkt"}
          pct={s ? usagePct(s.diskBytes, s.diskLimitBytes || diskLimit) : null}
        />
      </div>
      {!running && <p className="sr-only">Limiet CPU {formatCpuLimit(server.limits.cpuPct)}</p>}
    </Card>
  );
}
