"use client";
import { ArrowDown, ArrowUp, Clock, Cpu, HardDrive, MemoryStick, Network } from "lucide-react";
import type { Limits } from "@panel/api";
import type { ReactNode } from "react";
import { Card } from "@/app/_components/ui/card";
import { Progress } from "@/app/_components/ui/progress";
import type { LiveStats } from "@/app/_hooks/use-console";
import { formatBytes, formatDuration, formatMb, formatPct, usagePct } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

function Tile({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <Card className="space-y-2 p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      {children}
    </Card>
  );
}

export function LiveStatsPanel({ stats, limits, running }: { stats: LiveStats | null; limits: Limits; running: boolean }) {
  const t = useT();
  const s = running ? stats : null;
  const memLimit = s?.memoryLimitBytes || limits.ramMb * 1024 * 1024;
  const diskLimit = s?.diskLimitBytes || limits.diskMb * 1024 * 1024;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-1" data-testid="live-stats">
      <Tile icon={<Cpu />} label={t.server.cpu}>
        <div className="text-lg font-semibold tabular-nums">{s ? formatPct(s.cpuPct) : "–"}</div>
        <Progress value={s && limits.cpuPct ? usagePct(s.cpuPct, limits.cpuPct) : null} label={t.server.cpu} />
        <div className="text-xs text-muted-foreground">{t.server.limit(limits.cpuPct ? formatPct(limits.cpuPct) : t.common.unlimited)}</div>
      </Tile>
      <Tile icon={<MemoryStick />} label={t.server.memory}>
        <div className="text-lg font-semibold tabular-nums">{s ? formatBytes(s.memoryBytes) : "–"}</div>
        <Progress value={s ? usagePct(s.memoryBytes, memLimit) : null} label={t.server.memory} />
        <div className="text-xs text-muted-foreground">{t.server.ofX(formatBytes(memLimit))}</div>
      </Tile>
      <Tile icon={<HardDrive />} label={t.server.disk}>
        <div className="text-lg font-semibold tabular-nums">{s ? formatBytes(s.diskBytes) : "–"}</div>
        <Progress value={s ? usagePct(s.diskBytes, diskLimit) : null} label={t.server.disk} />
        <div className="text-xs text-muted-foreground">{t.server.ofX(limits.diskMb ? formatMb(limits.diskMb) : t.common.unlimited)}</div>
      </Tile>
      <Tile icon={<Network />} label={t.server.network}>
        <div className="flex items-center gap-1.5 text-sm tabular-nums">
          <ArrowDown className="size-3.5 text-info" /> {s?.rxPerSec != null ? `${formatBytes(s.rxPerSec)}/s` : "–"}
        </div>
        <div className="flex items-center gap-1.5 text-sm tabular-nums">
          <ArrowUp className="size-3.5 text-success" /> {s?.txPerSec != null ? `${formatBytes(s.txPerSec)}/s` : "–"}
        </div>
        <div className="text-xs text-muted-foreground">
          {s ? t.server.total(formatBytes(s.networkRxBytes), formatBytes(s.networkTxBytes)) : "–"}
        </div>
      </Tile>
      <Tile icon={<Clock />} label={t.server.uptime}>
        <div className="text-lg font-semibold tabular-nums">{s ? formatDuration(s.uptimeMs) : "–"}</div>
      </Tile>
    </div>
  );
}
