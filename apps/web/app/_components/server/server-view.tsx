"use client";
import { Lock, Moon, Play } from "lucide-react";
import { useRef, type ReactNode } from "react";
import type { ServerDetail } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { ImageUpdateNotice } from "@/app/_components/image-updates";
import { ConsolePanel } from "@/app/_components/console-panel";
import type { TerminalHandle } from "@/app/_components/console-terminal";
import { LiveStatsPanel } from "@/app/_components/live-stats";
import { BackendNotice } from "@/app/_components/server/network-manager";
import { PowerButtons } from "@/app/_components/power-buttons";
import { StatusBadge } from "@/app/_components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { displayName } from "@/app/_components/user-avatar";
import { useConsole } from "@/app/_hooks/use-console";
import { LogViewer, useLogLines } from "@/app/_components/log-viewer";
import { errorText } from "@/app/_lib/errors";
import { formatCpuLimit, formatDate, formatMb, isRunning } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

/** Console-tabblad: game-servers krijgen de console, websites een alleen-lezen logweergave. */
export function ServerView({ server }: { server: ServerDetail }) {
  const terminalRef = useRef<TerminalHandle | null>(null);
  const isWeb = server.type === "web";
  const logs = useLogLines();
  const live = useConsole(server, {
    onLine: (kind, text) => (isWeb ? logs.push(kind, text) : terminalRef.current?.write(kind, text)),
    onReset: () => (isWeb ? logs.clear() : terminalRef.current?.clear()),
  });
  const status = live.status ?? server.status;
  const perms = new Set(server.permissions);
  const canRead = perms.has("console.read");
  const t = useT();
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 30_000 });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {t.server.liveStatus} <StatusBadge status={status} />
        </div>
        {perms.has("power") && <PowerButtons status={status} pending={live.powerPending} onPower={(a) => void live.power(a).catch(() => {})} />}
      </div>
      {live.powerError && (
        <Alert variant="destructive">
          <div>
            <AlertTitle>{t.server.powerFailed}</AlertTitle>
            <AlertDescription>{errorText(live.powerError)}</AlertDescription>
          </div>
        </Alert>
      )}
      <ImageUpdateNotice server={server} canManage={server.isOwner || !!me.data?.isAdmin} />
      {status === "sleeping" && (
        <Alert className="border-indigo-400/40 bg-indigo-500/10 text-indigo-200" data-testid="sleeping-notice">
          <Moon />
          <div className="flex-1">
            <AlertTitle>{t.sleep.sleepingTitle}</AlertTitle>
            <AlertDescription>{t.sleep.sleepingText}</AlertDescription>
          </div>
          {perms.has("power") && (
            <Button size="sm" onClick={() => void live.power("start").catch(() => {})} disabled={!!live.powerPending}>
              <Play /> {t.power.start}
            </Button>
          )}
        </Alert>
      )}
      {server.network.role === "backend" && server.network.proxy && <BackendNotice proxyName={server.network.proxy.name} />}
      {status === "disk_exceeded" && (
        <Alert variant="destructive">
          <div>
            <AlertTitle>{t.server.diskTitle}</AlertTitle>
            <AlertDescription>{t.server.diskText}</AlertDescription>
          </div>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0">
          {canRead && isWeb ? (
            <LogViewer
              lines={logs.lines}
              onClear={logs.clear}
              fileName={`${server.name.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}.log.txt`}
              state={live.state}
              retryInMs={live.retryInMs}
              tokenRefreshedAt={live.tokenRefreshedAt}
              onRetry={live.retry}
            />
          ) : canRead ? (
            <ConsolePanel
              terminalRef={terminalRef}
              serverUuid={server.uuid}
              state={live.state}
              retryInMs={live.retryInMs}
              tokenRefreshedAt={live.tokenRefreshedAt}
              onRetry={live.retry}
              canWrite={perms.has("console.write")}
              onSend={live.sendCommand}
            />
          ) : (
            <Card className="grid h-64 place-items-center p-6 text-center text-sm text-muted-foreground">
              <div className="space-y-2">
                <Lock className="mx-auto size-6" />
                <p>{t.server.noConsole(isWeb)}</p>
              </div>
            </Card>
          )}
        </div>
        <LiveStatsPanel stats={live.stats} limits={server.limits} running={canRead && isRunning(status)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.server.details}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Detail label={t.server.serverId}>
              <code className="font-mono">{server.shortId}</code>
            </Detail>
            <Detail label={t.server.type}>{server.type === "web" ? t.server.typeWeb : t.server.typeGame}</Detail>
            <Detail label={t.server.node}>{server.node.fqdn}</Detail>
            <Detail label={t.server.owner}>{displayName(server.owner)}</Detail>
            <Detail label={t.server.cpuLimit}>{formatCpuLimit(server.limits.cpuPct)}</Detail>
            <Detail label={t.server.memory}>{formatMb(server.limits.ramMb)}</Detail>
            <Detail label={t.server.disk}>{server.limits.diskMb ? formatMb(server.limits.diskMb) : t.common.unlimited}</Detail>
            <Detail label={t.server.installed}>{server.installedAt ? formatDate(server.installedAt) : t.server.notYet}</Detail>
            {server.allocations.length > 0 && (
              <Detail label={t.server.ports} className="sm:col-span-2">
                {server.allocations.map((a) => `${a.ip}:${a.port}${a.primary ? ` ${t.server.primary}` : ""}`).join(", ")}
              </Detail>
            )}
          </dl>
        </CardContent>
      </Card>
    </div>
  );
}

function Detail({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}
