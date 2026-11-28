"use client";
import { Gamepad2, Globe, Users } from "lucide-react";
import type { PublicServerState, PublicStatus, PublicStatusServer } from "@panel/api";
import { CopyButton } from "@/app/_components/copy-button";
import { Badge, type BadgeVariant } from "@/app/_components/ui/badge";
import { Card, CardContent } from "@/app/_components/ui/card";
import { formatTime } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";

const STATE_VARIANT: Record<PublicServerState, BadgeVariant> = {
  online: "success",
  starting: "warning",
  sleeping: "sleep",
  offline: "destructive",
  maintenance: "warning",
  unknown: "secondary",
};
const OVERALL_COLOR: Record<PublicStatus["overall"], string> = {
  operational: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "bg-muted-foreground",
};

const pctText = (v: number | null, none: string) => (v === null ? none : `${v.toFixed(v === 100 ? 0 : 2)}%`);
/** Kleur van een uptime-vakje. */
function barColor(v: number | null): string {
  if (v === null) return "bg-muted";
  if (v >= 99.5) return "bg-success";
  if (v >= 95) return "bg-warning";
  return "bg-destructive";
}

function Bars({ values, label, title }: { values: (number | null)[]; label: string; title: (ago: number, pct: string) => string }) {
  const none = useT().statusPage.public.noData;
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="flex h-7 gap-[2px]" role="img" aria-label={label}>
        {values.map((v, i) => {
          const t = title(values.length - 1 - i, pctText(v, none));
          return <span key={i} className={cn("min-w-0 flex-1 rounded-sm", barColor(v))} title={t} aria-label={t} />;
        })}
      </div>
    </div>
  );
}

function ServerRow({ s }: { s: PublicStatusServer }) {
  const t = useT().statusPage.public;
  const Icon = s.type === "web" ? Globe : Gamepad2;
  return (
    <Card data-testid="public-server">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-lg font-semibold">{s.name}</h2>
          {s.players && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="players">
              <Users className="size-4" aria-hidden /> {t.players(s.players.online, s.players.max)}
            </span>
          )}
          <Badge variant={STATE_VARIANT[s.state]}>{t.states[s.state]}</Badge>
        </div>
        {s.address && (
          <div className="flex items-center gap-1 text-sm">
            <code className="rounded bg-muted px-2 py-0.5 font-mono">{s.address}</code>
            <CopyButton value={s.address} label={t.copyAddress} />
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">{t.uptime24h}</span>
              <span className="font-semibold tabular-nums">{pctText(s.uptime24h, t.noData)}</span>
            </div>
            <Bars values={s.hours} label={t.last24h} title={t.hourBar} />
          </div>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">{t.uptime7d}</span>
              <span className="font-semibold tabular-nums">{pctText(s.uptime7d, t.noData)}</span>
            </div>
            <Bars values={s.days} label={t.last7d} title={t.dayBar} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** De openbare statuspagina (zonder login). */
export function PublicStatusView({ status }: { status: PublicStatus }) {
  const t = useT().statusPage.public;
  return (
    <div className="space-y-6">
      <header className="space-y-2 text-center">
        <h1 className="text-3xl font-bold tracking-tight">{status.title}</h1>
        {status.description && <p className="text-balance text-muted-foreground">{status.description}</p>}
      </header>
      <div className="flex items-center justify-center gap-3 rounded-xl border border-border bg-card px-4 py-3" role="status" data-testid="overall">
        <span className={cn("size-3 rounded-full", OVERALL_COLOR[status.overall])} aria-hidden />
        <span className="font-medium">{t[status.overall]}</span>
      </div>
      <div className="space-y-4">
        {status.servers.map((s, i) => (
          <ServerRow key={i} s={s} />
        ))}
      </div>
      <p className="text-center text-xs text-muted-foreground">{t.updated(formatTime(status.updatedAt))}</p>
    </div>
  );
}
