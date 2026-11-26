"use client";
import { Lock } from "lucide-react";
import { useRef, type ReactNode } from "react";
import type { ServerDetail } from "@panel/api";
import { ConsolePanel } from "@/app/_components/console-panel";
import type { TerminalHandle } from "@/app/_components/console-terminal";
import { LiveStatsPanel } from "@/app/_components/live-stats";
import { PowerButtons } from "@/app/_components/power-buttons";
import { StatusBadge } from "@/app/_components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { displayName } from "@/app/_components/user-avatar";
import { useConsole } from "@/app/_hooks/use-console";
import { useServer } from "@/app/_hooks/use-server";
import { errorText } from "@/app/_lib/errors";
import { formatCpuLimit, formatDate, formatMb, isRunning } from "@/app/_lib/format";

export default function ServerPage() {
  const server = useServer();
  if (!server.data) return null; // de layout toont laden en fouten
  return <ServerView server={server.data} />;
}

function ServerView({ server }: { server: ServerDetail }) {
  const terminalRef = useRef<TerminalHandle | null>(null);
  const live = useConsole(server, {
    onLine: (kind, text) => terminalRef.current?.write(kind, text),
    onReset: () => terminalRef.current?.clear(),
  });
  const status = live.status ?? server.status;
  const perms = new Set(server.permissions);
  const canRead = perms.has("console.read");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          Live status <StatusBadge status={status} />
        </div>
        {perms.has("power") && <PowerButtons status={status} pending={live.powerPending} onPower={(a) => void live.power(a).catch(() => {})} />}
      </div>
      {live.powerError && (
        <Alert variant="destructive">
          <div>
            <AlertTitle>Power-actie mislukt</AlertTitle>
            <AlertDescription>{errorText(live.powerError)}</AlertDescription>
          </div>
        </Alert>
      )}
      {status === "disk_exceeded" && (
        <Alert variant="destructive">
          <div>
            <AlertTitle>Schijflimiet bereikt</AlertTitle>
            <AlertDescription>De server is gestopt omdat de schijf vol is. Maak ruimte vrij of vraag een beheerder om de limiet te verhogen.</AlertDescription>
          </div>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
        <div className="min-w-0">
          {canRead ? (
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
                <p>Je hebt geen recht om de console van deze server te bekijken.</p>
              </div>
            </Card>
          )}
        </div>
        <LiveStatsPanel stats={live.stats} limits={server.limits} running={canRead && isRunning(status)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="Server-ID">
              <code className="font-mono">{server.shortId}</code>
            </Detail>
            <Detail label="Type">{server.type === "web" ? "Website" : "Game-server"}</Detail>
            <Detail label="Node">{server.node.fqdn}</Detail>
            <Detail label="Eigenaar">{displayName(server.owner)}</Detail>
            <Detail label="CPU-limiet">{formatCpuLimit(server.limits.cpuPct)}</Detail>
            <Detail label="Geheugen">{formatMb(server.limits.ramMb)}</Detail>
            <Detail label="Schijf">{server.limits.diskMb ? formatMb(server.limits.diskMb) : "onbeperkt"}</Detail>
            <Detail label="Geïnstalleerd">{server.installedAt ? formatDate(server.installedAt) : "nog niet"}</Detail>
            {server.allocations.length > 0 && (
              <Detail label="Poorten" className="sm:col-span-2">
                {server.allocations.map((a) => `${a.ip}:${a.port}${a.primary ? " (primair)" : ""}`).join(", ")}
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
