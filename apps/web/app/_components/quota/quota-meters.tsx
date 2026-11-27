"use client";
import type { QuotaOverview } from "@panel/api";
import { UsageMeter } from "@/app/_components/usage-meter";
import { useT } from "@/app/_lib/i18n";

const pct = (used: number, max: number) => (max <= 0 ? 100 : Math.min(100, Math.round((used / max) * 100)));

/** Verbruik / beschikbaar per resource van het eigen quotum. */
export function QuotaMeters({ overview }: { overview: QuotaOverview }) {
  const t = useT().quota;
  const { quota: q, usage: u } = overview;
  const rows = [
    { key: "ram", label: t.ram, used: u.ramMb, max: q.maxRamMb },
    { key: "disk", label: t.disk, used: u.diskMb, max: q.maxDiskMb },
    { key: "cpu", label: t.cpu, used: u.cpuPct, max: q.maxCpuPct },
    { key: "servers", label: t.servers, used: u.servers, max: q.maxServers },
    { key: "databases", label: t.databases, used: u.databases, max: q.maxDatabases },
  ];
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5" data-testid="quota-meters">
      {rows.map((r) => (
        <div key={r.key} data-testid={`quota-${r.key}`} title={t.available(String(Math.max(0, r.max - r.used)))}>
          <UsageMeter label={r.label} value={String(r.used)} detail={String(r.max)} pct={pct(r.used, r.max)} />
        </div>
      ))}
    </div>
  );
}
