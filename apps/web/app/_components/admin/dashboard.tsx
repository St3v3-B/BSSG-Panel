"use client";
import { Activity, AlertTriangle, CheckCircle2, HardDrive, Plus, Server, Settings, Users } from "lucide-react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Progress } from "@/app/_components/ui/progress";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { formatBytes, formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { ActiveAlarms } from "@/app/_components/admin/alarms";
import { OutdatedBadge, UpdateNotices } from "@/app/_components/admin/version-notices";

function Stat({ label, value, href, testId, icon: Icon }: { label: string; value: ReactNode; href?: string; testId: string; icon: LucideIcon }) {
  const body = (
    <Card className="relative h-full overflow-hidden p-3.5 sm:p-4" data-testid={testId}>
      <span aria-hidden className="pointer-events-none absolute -right-6 -top-6 size-20 rounded-full bg-primary/20 blur-2xl" />
      <span className="mb-2 grid size-8 place-items-center rounded-lg bg-primary/12 text-primary sm:size-9">
        <Icon className="size-4 sm:size-[18px]" />
      </span>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-bold leading-tight tabular-nums sm:text-2xl">{value}</div>
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-2xl transition-transform hover:-translate-y-0.5">
      {body}
    </Link>
  ) : (
    body
  );
}

export function AdminDashboard() {
  const t = useT();
  const d = t.admin2.dashboard;
  const q = trpc.admin.dashboard.useQuery(undefined, { refetchInterval: 30_000 });
  const nodes = trpc.admin.nodes.list.useQuery();
  if (q.error) return <QueryError error={q.error} />;
  if (!q.data)
    return (
      <div className="space-y-6" aria-busy>
        <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
    );
  const { nodes: health, alerts, serverCount, userCount } = q.data;
  const nameOf = (id: number) => nodes.data?.find((n) => n.id === id)?.name ?? `node ${id}`;
  const online = health.filter((h) => h.online).length;

  return (
    <div className="space-y-6" data-testid="admin-dashboard">
      <UpdateNotices />
      <div className="grid grid-cols-3 gap-2.5 sm:gap-3">
        <Stat label={d.servers} value={serverCount} href="/admin/servers" testId="stat-servers" icon={Server} />
        <Stat label={d.users} value={userCount} href="/admin/users" testId="stat-users" icon={Users} />
        <Stat label={d.nodes} value={d.nodesOnline(online, health.length)} href="/admin/nodes" testId="stat-nodes" icon={HardDrive} />
      </div>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{d.nodes}</h2>
        {health.length === 0 ? (
          <p className="text-sm text-muted-foreground">{d.noNodes}</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {health.map((h) => {
              const mem = h.memoryTotalBytes ? Math.round(((h.memoryUsedBytes ?? 0) / h.memoryTotalBytes) * 100) : null;
              return (
                <Link key={h.nodeId} href={`/admin/nodes/${h.nodeId}`} className="block rounded-2xl transition-transform hover:-translate-y-0.5" data-testid="dash-node">
                  <Card>
                    <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
                      <CardTitle className="text-base">{nameOf(h.nodeId)}</CardTitle>
                      <span className="flex flex-wrap justify-end gap-1.5">
                        <OutdatedBadge nodeId={h.nodeId} />
                        <Badge variant={h.online ? "success" : "destructive"}>{h.online ? d.online : d.offline}</Badge>
                      </span>
                    </CardHeader>
                    <CardContent className="space-y-2.5 text-sm text-muted-foreground">
                      <div>{d.serverCount(h.serverCount)}</div>
                      {h.online ? (
                        <>
                          <div className="space-y-1">
                            <div>
                              {d.memory}: {formatBytes(h.memoryUsedBytes)} / {formatBytes(h.memoryTotalBytes)}
                              {mem !== null && ` (${mem}%)`}
                            </div>
                            <Progress value={mem} label={d.memory} />
                          </div>
                          <div className="space-y-1">
                            <div>
                              {d.disk}: {formatBytes(h.diskFreeBytes)} / {formatBytes(h.diskTotalBytes)}
                            </div>
                            <Progress value={h.diskTotalBytes ? Math.round((1 - (h.diskFreeBytes ?? 0) / h.diskTotalBytes) * 100) : null} label={d.disk} />
                          </div>
                        </>
                      ) : (
                        h.error && <div className="text-destructive">{h.error}</div>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{d.alerts}</h2>
        {alerts.length === 0 ? (
          <Card className="flex items-center gap-3 p-4 text-sm text-muted-foreground" data-testid="no-alerts">
            <span className="grid size-9 place-items-center rounded-xl bg-success/12 text-success">
              <CheckCircle2 className="size-5" />
            </span>
            {d.noAlerts}
          </Card>
        ) : (
          <Card className="divide-y divide-border" data-testid="alerts">
            {alerts.map((a, i) => (
              <div key={i} className="flex items-start gap-3 p-3 text-sm" data-testid="alert">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{d.alertKind[a.kind] ?? a.kind}</div>
                  <div className="text-muted-foreground">{a.message}</div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground">
                  {formatDate(a.at)}
                  {a.serverUuid && (
                    <Link href={`/admin/servers/${a.serverUuid}`} className="text-foreground hover:underline">
                      {t.admin2.list.title}
                    </Link>
                  )}
                  {!a.serverUuid && a.nodeId && (
                    <Link href={`/admin/nodes/${a.nodeId}`} className="text-foreground hover:underline">
                      {d.nodes}
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </Card>
        )}
      </section>

      <ActiveAlarms />

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{d.quick}</h2>
        <div className="grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
          <Button asChild>
            <Link href="/admin/servers/new">
              <Plus /> {d.createServer}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/servers">
              <Server /> {d.allServers}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/users">
              <Users /> {d.manageUsers}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/activity">
              <Activity /> {d.activity}
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/admin/settings">
              <Settings /> {d.settings}
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}
