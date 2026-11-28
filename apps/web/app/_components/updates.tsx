"use client";
import { ArrowRight, ArrowUpCircle, CheckCircle2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { CiStatus, UpdatesStatus } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Badge, type BadgeVariant } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/app/_components/ui/dialog";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

const CI_VARIANT: Record<CiStatus, BadgeVariant> = { success: "success", failure: "destructive", pending: "warning", none: "secondary", unknown: "secondary" };
const STATE_VARIANT: Record<string, BadgeVariant> = { running: "info", success: "success", failed: "destructive", rolled_back: "warning", idle: "secondary" };
const short = (sha: string) => sha.slice(0, 8);
const date = (d: string | null) => (d && !Number.isNaN(Date.parse(d)) ? formatDate(new Date(d)) : "");

/** Admin > Settings > Updates: versie, beschikbare commits met CI, "Panel bijwerken" en live voortgang. */
export function UpdatesAdmin() {
  const t = useT().updates;
  const tc = useT().common;
  const utils = trpc.useUtils();
  const [onlyGreen, setOnlyGreen] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [startedHere, setStartedHere] = useState(false);
  const [checking, setChecking] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  // Pollt elke 3 s zolang er een update loopt, en ook als het panel even weg is (herstart): data blijft staan.
  const q = trpc.admin.updates.status.useQuery(
    { refresh: false },
    { refetchInterval: (query) => (startedHere || query.state.data?.upgrade?.state === "running" || query.state.status === "error" || query.state.fetchFailureCount > 0 ? 3000 : 60_000), retry: true, retryDelay: 2000 },
  );
  const refresh = async () => {
    setChecking(true);
    try {
      const d = await utils.admin.updates.status.fetch({ refresh: true });
      utils.admin.updates.status.setData({ refresh: false }, d);
    } catch {
      /* de gewone poll toont de fout */
    } finally {
      setChecking(false);
      setNow(Date.now());
    }
  };
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const start = trpc.admin.updates.start.useMutation({
    onSuccess: () => {
      setConfirm(false);
      setStartedHere(true);
      void utils.admin.updates.status.invalidate();
    },
  });
  const toggle = trpc.admin.updates.setEnabled.useMutation({ onSuccess: () => utils.admin.updates.status.invalidate() });
  const data: UpdatesStatus | undefined = q.data;
  const running = data?.upgrade?.state === "running";
  useEffect(() => {
    // Een run die we zelf startten is klaar zodra de status niet meer "running" is en een nieuwe run toont.
    if (startedHere && data?.upgrade && data.upgrade.state !== "running" && data.upgrade.finished) setStartedHere(false);
  }, [startedHere, data]);

  if (!data) return q.error ? <QueryError error={q.error} /> : <Skeleton className="h-48 rounded-xl" />;
  const reconnecting = q.isRefetchError || (q.fetchStatus === "idle" && q.isError);
  const up = data.upgrade;
  const busy = running || startedHere;
  const behind = data.behind;
  const count = behind ?? data.available.length;
  const canStart = data.enabled && data.canUpgrade && !busy && count > 0;
  return (
    <div className="space-y-6" data-testid="updates-admin">
      {reconnecting && (
        <Alert role="status">
          <AlertDescription>{t.reconnecting}</AlertDescription>
        </Alert>
      )}

      <Card data-testid="version-overview">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-base">{t.overview}</CardTitle>
            <CardDescription>{data.current.sha === "unknown" ? t.versionUnknown : t.commitLine(short(data.current.sha), date(data.current.date))}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={checking} data-testid="check-now">
            {checking ? <Spinner /> : <RefreshCw />} {t.checkNow}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div>
              <p className="text-xs text-muted-foreground">{t.currentVersion}</p>
              <p className="font-mono text-2xl font-semibold tabular-nums" data-testid="current-version">
                {data.currentVersion ?? "–"}
              </p>
            </div>
            {behind !== null && behind > 0 && data.latestVersion && (
              <>
                <ArrowRight className="size-5 text-muted-foreground" aria-hidden />
                <div>
                  <p className="text-xs text-muted-foreground">{t.latestVersion}</p>
                  <p className="font-mono text-2xl font-semibold tabular-nums text-primary" data-testid="latest-version">
                    {data.latestVersion}
                  </p>
                </div>
              </>
            )}
          </div>
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t.statusLabel}</dt>
            <dd data-testid="update-status">
              {data.upToDate === true ? (
                <Badge variant="success">
                  <CheckCircle2 /> {t.statusUpToDate}
                </Badge>
              ) : behind !== null && behind > 0 ? (
                <Badge variant="warning">
                  <ArrowUpCircle /> {t.statusBehind(behind)}
                </Badge>
              ) : (
                <span className="space-y-1">
                  <Badge variant="secondary">{t.statusUnknown}</Badge>
                  <span className="block text-xs text-muted-foreground">{t.statusUnknownHint}</span>
                </span>
              )}
            </dd>
            <dt className="text-muted-foreground">{t.latestVersion}</dt>
            <dd className="font-mono tabular-nums">{behind === 0 ? <span className="font-sans text-muted-foreground">{t.noNewer}</span> : (data.latestVersion ?? "–")}</dd>
            <dt className="text-muted-foreground">{t.lastChecked}</dt>
            <dd data-testid="last-checked">{data.checkedAt ? `${formatDate(data.checkedAt)} (${t.ago(Math.max(0, now - data.checkedAt.getTime()))})` : t.neverChecked}</dd>
          </dl>
          {data.current.message && <p className="text-sm">{data.current.message}</p>}
          {data.daemonVersion && <p className="text-xs text-muted-foreground">{t.daemon(data.daemonVersion, data.daemonCommit ? short(data.daemonCommit) : "")}</p>}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={data.enabled} disabled={toggle.isPending} onChange={(e) => toggle.mutate({ enabled: e.target.checked })} aria-label={t.enabled} />
            <span>
              {t.enabled}
              <span className="block text-xs text-muted-foreground">{t.enabledHint}</span>
            </span>
          </label>
          {toggle.error && <p className="text-sm text-destructive">{errorText(toggle.error)}</p>}
        </CardContent>
      </Card>

      {(busy || (up && up.state !== "idle")) && up && (
        <Card data-testid="upgrade-run">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              {busy ? t.progress : t.lastResult}
              <Badge variant={STATE_VARIANT[busy ? "running" : up.state]}>{busy && up.state !== "running" ? t.state.running : t.state[up.state]}</Badge>
            </CardTitle>
            <CardDescription>
              {up.from && up.to ? t.fromTo(short(up.from), short(up.to)) : ""} {up.finished ? t.finishedAt(date(up.finished)) : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {busy && (
              <p className="flex items-center gap-2 text-sm">
                <Spinner /> {t.steps}: {up.step || "…"}
              </p>
            )}
            {up.error && <p className="text-sm text-destructive">{up.error}</p>}
            {up.state === "success" && !busy && <p className="text-xs text-muted-foreground">{t.nodesHint}</p>}
            {data.logTail && (
              <details open={busy}>
                <summary className="cursor-pointer text-sm text-muted-foreground">{t.log}</summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted p-3 text-xs">{data.logTail}</pre>
              </details>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.available}</CardTitle>
          <CardDescription>
            {count === 0 ? t.upToDate : t.availableCount(count)}
            {count > data.available.length && data.available.length > 0 ? ` ${t.shownOf(data.available.length, count)}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {data.error && <p className="text-sm text-destructive">{data.error === "NOT_LOCAL" ? t.noRepo : data.error}</p>}
          {!data.enabled && <p className="text-sm text-muted-foreground">{t.disabledNotice}</p>}
          {data.available.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border" data-testid="available-updates">
              {data.available.map((c) => (
                <li key={c.sha} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate">{c.message}</span>
                    <span className="text-xs text-muted-foreground">
                      {short(c.sha)}
                      {c.author ? ` · ${c.author}` : ""}
                      {date(c.date) ? ` · ${date(c.date)}` : ""}
                    </span>
                  </span>
                  <Badge variant={CI_VARIANT[c.ci]}>{t.ci[c.ci]}</Badge>
                </li>
              ))}
            </ul>
          )}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onlyGreen} onChange={(e) => setOnlyGreen(e.target.checked)} aria-label={t.onlyGreen} />
            {t.onlyGreen}
          </label>
          <div className="flex items-center gap-3">
            <Button onClick={() => (start.reset(), setConfirm(true))} disabled={!canStart}>
              <ArrowUpCircle /> {t.updateButton}
            </Button>
            {start.isSuccess && <span className="text-sm text-success" role="status">{t.started}</span>}
          </div>
        </CardContent>
      </Card>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <DialogTitle>{t.confirmTitle}</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">{data.currentVersion && data.latestVersion && count > 0 ? `${t.fromTo(data.currentVersion, data.latestVersion)}. ` : ""}
            {t.confirmText(count)}</DialogDescription>
          {start.error && <p className="mt-3 text-sm text-destructive">{errorText(start.error)}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="outline">{tc.cancel}</Button>
            </DialogClose>
            <Button onClick={() => start.mutate({ onlyIfCiGreen: onlyGreen })} disabled={start.isPending}>
              {start.isPending && <Spinner />} {t.confirmGo}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
