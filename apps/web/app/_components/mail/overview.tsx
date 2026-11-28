"use client";
import { ArrowRight, AtSign, CircleAlert, Clock3, Globe, HardDrive, Inbox, Mail, PauseCircle, Send, ServerOff, Settings2, Users } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { MailContainer, MailStatus } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/app/_components/ui/dialog";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatBytes } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";
import { Dot, Switch } from "./primitives";
import { SystemCheck } from "./system-check";

type Health = "healthy" | "unhealthy" | "starting" | "running" | "stopped";
function containerHealth(c: MailContainer): Health {
  if (c.state !== "running") return "stopped";
  if (c.health === "healthy" || c.health === "unhealthy" || c.health === "starting") return c.health;
  return "running";
}
const HEALTH_TONE = { healthy: "success", running: "success", starting: "warning", unhealthy: "destructive", stopped: "muted" } as const;

export function ContainerChip({ c }: { c: MailContainer }) {
  const t = useT().mail.overview;
  const h = containerHealth(c);
  const short = c.name.replace(/^panel-/, "");
  return (
    <li
      className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 py-1 pl-2.5 pr-3 text-xs shadow-xs"
      title={`${c.name}: ${c.state}${c.health ? ` (${c.health})` : ""}`}
      data-testid="mail-container"
      data-health={h}
    >
      <Dot tone={HEALTH_TONE[h]} pulse={h === "starting"} />
      <span className="font-mono font-medium">{short}</span>
      <span className="text-muted-foreground">{t.health[h]}</span>
    </li>
  );
}

function MiniStat({ icon: Icon, label, value, href, tone = "primary", testId, children }: { icon: typeof Mail; label: string; value: ReactNode; href?: string; tone?: "primary" | "warning" | "info"; testId: string; children?: ReactNode }) {
  const tile = { primary: "bg-primary/12 text-primary", warning: "bg-warning/12 text-warning", info: "bg-info/12 text-info" }[tone];
  const body = (
    <Card className="relative h-full overflow-hidden p-4" data-testid={testId}>
      <span aria-hidden className="pointer-events-none absolute -right-8 -top-8 size-24 rounded-full bg-primary/15 blur-2xl" />
      <div className="flex items-center gap-2.5">
        <span className={cn("grid size-8 place-items-center rounded-lg", tile)}>
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {href && <ArrowRight className="ml-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />}
      </div>
      <div className="mt-2.5 text-2xl font-bold leading-tight tabular-nums">{value}</div>
      {children}
    </Card>
  );
  return href ? (
    <Link href={href} className="group block rounded-2xl transition-transform outline-none hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring/50">
      {body}
    </Link>
  ) : (
    body
  );
}

function QueueCard({ q }: { q: MailStatus["queue"] }) {
  const t = useT().mail.overview;
  const items = [
    { k: "active", label: t.queueActive, v: q?.active, icon: Send, tone: "text-info" },
    { k: "deferred", label: t.queueDeferred, v: q?.deferred, icon: Clock3, tone: "text-warning" },
    { k: "hold", label: t.queueHold, v: q?.hold, icon: PauseCircle, tone: "text-muted-foreground" },
  ];
  return (
    <Link href="/admin/mail/queue" className="group block rounded-2xl transition-transform outline-none hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring/50 col-span-2" title={t.openQueue}>
      <Card className="relative h-full overflow-hidden p-4" data-testid="mail-queue-card">
        <span aria-hidden className="pointer-events-none absolute -right-8 -top-8 size-24 rounded-full bg-primary/15 blur-2xl" />
        <div className="flex items-center gap-2.5">
          <span className="grid size-8 place-items-center rounded-lg bg-primary/12 text-primary">
            <Inbox className="size-4" aria-hidden />
          </span>
          <span className="text-xs font-medium text-muted-foreground">{t.queue}</span>
          <ArrowRight className="ml-auto size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
        </div>
        <dl className="mt-2.5 grid grid-cols-3 gap-2">
          {items.map((i) => (
            <div key={i.k} className="rounded-xl bg-muted/50 px-3 py-2">
              <dt className="flex items-center gap-1.5 text-[11px] leading-tight text-muted-foreground sm:text-xs">
                <i.icon className={cn("size-3.5 shrink-0 max-sm:hidden", i.tone)} aria-hidden />
                <span className="min-w-0 break-words">{i.label}</span>
              </dt>
              <dd className={cn("text-xl font-bold tabular-nums", i.k === "deferred" && (i.v ?? 0) > 0 && "text-warning")} data-testid={`mail-queue-${i.k}`}>
                {i.v ?? "–"}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </Link>
  );
}

/** Grote statuskaart met de aan/uit-schakelaar. */
function StackCard({ status }: { status: MailStatus }) {
  const t = useT().mail.overview;
  const tc = useT().common;
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState<"on" | "off" | null>(null);
  const done = () => {
    setConfirm(null);
    void utils.mail.status.invalidate();
  };
  const enable = trpc.mail.enable.useMutation({ onSuccess: done, onError: () => void utils.mail.checks.last.invalidate() });
  const disable = trpc.mail.disable.useMutation({ onSuccess: done });
  const failed = status.lastCheck?.failedRequired ?? [];
  const blocked = !status.enabled && (status.lastCheck === null || failed.length > 0);
  const on = status.enabled;
  const busy = enable.isPending || disable.isPending;
  const host = status.mailHostname ?? "";
  const mut = confirm === "on" ? enable : disable;

  return (
    <Card className="relative overflow-hidden" data-testid="mail-stack-card" data-enabled={on}>
      <span aria-hidden className={cn("pointer-events-none absolute -right-16 -top-24 size-72 rounded-full blur-3xl transition-colors duration-700", on ? "bg-success/15" : "bg-muted-foreground/10")} />
      <span aria-hidden className="pointer-events-none absolute -bottom-24 left-1/3 size-64 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex items-start gap-4 p-5 sm:items-center sm:p-6">
        <div className="flex min-w-0 flex-1 items-start gap-4 sm:items-center">
          <span className={cn("relative grid size-14 shrink-0 place-items-center rounded-2xl text-white shadow-lg transition-colors duration-500", on ? "brand-gradient shadow-primary/30" : "bg-muted-foreground/40")}>
            <Mail className="size-7" aria-hidden />
            <span className={cn("absolute -bottom-1 -right-1 grid size-5 place-items-center rounded-full border-2 border-card", on ? "bg-success" : "bg-muted-foreground")}>
              {on && <span className="absolute inset-0 animate-ping rounded-full bg-success opacity-40" />}
            </span>
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl" data-testid="mail-stack-state">
              {on ? t.stackOn : t.stackOff}
            </h2>
            <p className="text-sm text-muted-foreground">{on ? t.stackOnText(host) : t.stackOffText}</p>
            {host && <p className="mt-1 inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground"><AtSign className="size-3.5" aria-hidden />{host}</p>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {busy && <Spinner className="text-muted-foreground" />}
          <Switch size="lg" checked={on} disabled={busy || (blocked && !on)} label={t.toggleLabel} onCheckedChange={(v) => (enable.reset(), disable.reset(), setConfirm(v ? "on" : "off"))} data-testid="mail-toggle" />
        </div>
      </div>
      {blocked && (
        <div className="relative border-t border-warning/25 bg-warning/[0.07] px-5 py-3 text-sm sm:px-6" data-testid="mail-blocked">
          <div className="flex items-start gap-2.5">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div>
              <span className="font-medium text-warning">{t.blockedTitle}.</span> <span className="text-muted-foreground">{status.lastCheck === null ? t.neverCheckedText : t.blockedText(failed.length)}</span>
            </div>
          </div>
        </div>
      )}
      <div className="relative border-t border-border px-5 py-3.5 sm:px-6">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t.containers}</div>
        {status.containers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noContainers}</p>
        ) : (
          <ul className="flex flex-wrap gap-2" aria-label={t.containers}>
            {status.containers.map((c) => (
              <ContainerChip key={c.name} c={c} />
            ))}
          </ul>
        )}
      </div>

      <Dialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <DialogContent closeLabel={tc.close}>
          <span className={cn("mb-3 grid size-11 place-items-center rounded-xl", confirm === "on" ? "bg-success/12 text-success" : "bg-destructive/12 text-destructive")}>
            {confirm === "on" ? <Mail className="size-5" /> : <ServerOff className="size-5" />}
          </span>
          <DialogTitle className="text-lg font-semibold">{confirm === "on" ? t.enableTitle : t.disableTitle}</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">{confirm === "on" ? t.enableText(host) : t.disableText}</DialogDescription>
          {mut.error && (
            <Alert variant="destructive" className="mt-4">
              <CircleAlert />
              <AlertDescription className="mt-0">{errorText(mut.error)}</AlertDescription>
            </Alert>
          )}
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <DialogClose asChild>
              <Button variant="outline">{tc.cancel}</Button>
            </DialogClose>
            <Button variant={confirm === "on" ? "default" : "destructive"} onClick={() => mut.mutate()} disabled={mut.isPending} data-testid="mail-toggle-confirm">
              {mut.isPending && <Spinner />} {confirm === "on" ? t.enableGo : t.disableGo}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-5" aria-busy>
      <Skeleton className="h-52 rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-4">
        <Skeleton className="h-32 rounded-2xl sm:col-span-2" />
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-32 rounded-2xl" />
      </div>
      <Skeleton className="h-96 rounded-2xl" />
    </div>
  );
}

export function MailOverview() {
  const t = useT().mail.overview;
  const q = trpc.mail.status.useQuery(undefined, { refetchInterval: 15_000 });
  if (q.error) return <QueryError error={q.error} />;
  if (!q.data) return <OverviewSkeleton />;
  const s = q.data;
  if (!s.configured) {
    return (
      <Card data-testid="mail-not-configured">
        <EmptyState icon={Settings2} title={t.notConfiguredTitle}>
          {t.notConfiguredText}
        </EmptyState>
        <div className="-mt-6 flex justify-center pb-10">
          <code className="rounded-lg border border-border bg-muted/60 px-3 py-1.5 font-mono text-sm">MAIL_HOSTNAME=mail.example.com</code>
        </div>
      </Card>
    );
  }
  return (
    <div className="space-y-5 sm:space-y-6" data-testid="mail-overview">
      {!s.reachable && (
        <Alert variant="destructive" data-testid="mail-unreachable">
          <ServerOff />
          <div>
            <AlertTitle>{t.unreachableTitle}</AlertTitle>
            <AlertDescription>{t.unreachableText}</AlertDescription>
          </div>
        </Alert>
      )}
      {s.reachable && <StackCard status={s} />}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <QueueCard q={s.queue} />
        <MiniStat icon={HardDrive} label={t.storage} value={s.vmailBytes == null ? "–" : formatBytes(s.vmailBytes)} testId="mail-storage">
          <p className="mt-0.5 text-xs text-muted-foreground">{t.storageText}</p>
        </MiniStat>
        <MiniStat icon={Globe} label={t.domains} value={s.counts.domains} href="/admin/mail/domains" testId="mail-counts">
          <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Users className="size-3" aria-hidden /> {s.counts.mailboxes} {t.mailboxes.toLowerCase()}
            </span>
            <span className="inline-flex items-center gap-1">
              <AtSign className="size-3" aria-hidden /> {s.counts.aliases} {t.aliases.toLowerCase()}
            </span>
          </p>
        </MiniStat>
      </div>
      <SystemCheck host={s.mailHostname} configured={s.configured} />
    </div>
  );
}
