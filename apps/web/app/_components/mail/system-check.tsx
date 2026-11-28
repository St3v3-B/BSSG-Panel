"use client";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  ChevronDown,
  Clock,
  HardDrive,
  Hand,
  Inbox,
  Lightbulb,
  Lock,
  Plug,
  RefreshCw,
  Repeat2,
  Send,
  ShieldBan,
  ShieldCheck,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import type { MailCheck, MailCheckId, MailCheckReport } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";
import { CopyValue, ProgressRing, RelativeTime } from "./primitives";

export const CHECK_ORDER: MailCheckId[] = ["outbound_25", "inbound_ports", "ptr", "fcrdns", "helo", "blacklists", "certificate", "ports_free", "clock", "disk"];

const CHECK_ICON: Record<MailCheckId, LucideIcon> = {
  outbound_25: Send,
  inbound_ports: Inbox,
  ptr: ArrowLeftRight,
  fcrdns: Repeat2,
  helo: Hand,
  blacklists: ShieldBan,
  certificate: Lock,
  ports_free: Plug,
  clock: Clock,
  disk: HardDrive,
};

type Tone = "ok" | "fail" | "warn";
export const checkTone = (c: Pick<MailCheck, "ok" | "required">): Tone => (c.ok ? "ok" : c.required ? "fail" : "warn");
const RANK: Record<Tone, number> = { fail: 0, warn: 1, ok: 2 };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
/** IP uit check-data: de daemon geeft `{ ip, names }` per adresfamilie (ptr/fcrdns), oudere vormen een kale string. */
const ipOf = (v: unknown) => str(v) ?? (v && typeof v === "object" ? str((v as { ip?: unknown }).ip) : null);

/** Waarden die de beheerder letterlijk moet invullen, afgeleid van het rapport en de mail-hostnaam. */
function copyValues(c: MailCheck, report: MailCheckReport, host: string | null, t: ReturnType<typeof useT>["mail"]["checks"]["valueLabels"]): Array<{ label: string; value: string }> {
  const ptrData = report.checks.find((x) => x.id === "ptr")?.data ?? null;
  const ip = ipOf(c.data?.ipv4) ?? ipOf(ptrData?.ipv4);
  const ip6 = ipOf(c.data?.ipv6) ?? ipOf(ptrData?.ipv6);
  const out: Array<{ label: string; value: string }> = [];
  const add = (label: string, value: string | null) => value && out.push({ label, value });
  switch (c.id) {
    case "ptr":
      add(t.ip, ip);
      add(t.ipv6, ip6);
      add(t.hostname, host);
      break;
    case "fcrdns":
      add(t.hostname, host);
      add(t.aRecord, host && ip ? `${host}. IN A ${ip}` : null);
      break;
    case "helo":
    case "certificate":
      add(t.hostname, host);
      break;
    case "inbound_ports": {
      const closed = Array.isArray(c.data?.closed) ? (c.data.closed as unknown[]).map(String) : [];
      add(t.ports, closed.length ? closed.join(", ") : "25, 465, 587, 993");
      break;
    }
    case "clock":
      add(t.ntp, "timedatectl set-ntp true");
      break;
  }
  return out;
}

function StatusIcon({ tone, running }: { tone: Tone | null; running?: boolean }) {
  if (running) return <Spinner className="size-5 text-muted-foreground" />;
  if (tone === "ok") return <CheckCircle2 className="size-5 text-success" aria-hidden />;
  if (tone === "fail") return <XCircle className="size-5 text-destructive" aria-hidden />;
  if (tone === "warn") return <AlertTriangle className="size-5 text-warning" aria-hidden />;
  return <span className="size-5" />;
}

function CheckRow({ check, report, host, running, initiallyOpen }: { check: MailCheck; report: MailCheckReport; host: string | null; running: boolean; initiallyOpen: boolean }) {
  const t = useT().mail.checks;
  const tone = checkTone(check);
  const [open, setOpen] = useState(initiallyOpen);
  const Icon = CHECK_ICON[check.id];
  const values = copyValues(check, report, host, t.valueLabels);
  const panelId = `check-help-${check.id}`;
  const statusText = tone === "ok" ? t.statusOk : tone === "fail" ? t.statusFail : t.statusWarn;
  return (
    <li
      className={cn(
        "group relative px-4 py-3.5 transition-colors sm:px-5",
        !running && tone === "fail" && "bg-destructive/[0.04]",
        !running && tone === "warn" && "bg-warning/[0.04]",
      )}
      data-testid={`mail-check-${check.id}`}
      data-tone={running ? "running" : tone}
    >
      {!running && tone !== "ok" && <span aria-hidden className={cn("absolute inset-y-0 left-0 w-0.5", tone === "fail" ? "bg-destructive" : "bg-warning")} />}
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-xl transition-colors",
            running ? "bg-muted text-muted-foreground" : tone === "ok" ? "bg-success/12 text-success" : tone === "fail" ? "bg-destructive/12 text-destructive" : "bg-warning/12 text-warning",
          )}
        >
          <Icon className="size-[18px]" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-medium">{t.names[check.id]}</span>
            <Badge variant={check.required ? "outline" : "secondary"} className="text-[11px] font-normal">
              {check.required ? t.required : t.optional}
            </Badge>
            <span className="sr-only">{running ? t.running : statusText}</span>
          </div>
          {running ? <Skeleton className="mt-1.5 h-3.5 w-3/4 max-w-sm" /> : <p className="mt-0.5 break-words text-sm text-muted-foreground">{check.detail}</p>}
          {!running && tone !== "ok" && (
            <>
              <button
                type="button"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
                aria-controls={panelId}
                className={cn("mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-md text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/50", tone === "fail" ? "text-destructive" : "text-warning")}
              >
                <Lightbulb className="size-4" aria-hidden />
                {t.whatToDo}
                <ChevronDown className={cn("size-4 transition-transform duration-200", open && "rotate-180")} aria-hidden />
              </button>
              <div id={panelId} hidden={!open} className="-ml-12 mt-2 animate-fade sm:ml-0 space-y-3 rounded-xl border border-border bg-card/70 p-3 text-sm sm:p-4">
                <p className="leading-relaxed">{t.help[check.id]}</p>
                {check.hint && (
                  <p className="text-muted-foreground">
                    <span className="font-medium text-foreground">{t.daemonHint}:</span> {check.hint}
                  </p>
                )}
                {values.length > 0 && (
                  <div className="space-y-2">
                    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t.values}</div>
                    {values.map((v) => (
                      <div key={v.label} className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:items-center sm:gap-3">
                        <span className="text-xs text-muted-foreground">{v.label}</span>
                        <CopyValue value={v.value} label={`${t.values}: ${v.label}`} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        <span className="mt-1.5 shrink-0">
          <StatusIcon tone={running ? null : tone} running={running} />
        </span>
      </div>
    </li>
  );
}

/** Systeemcheck: voortgangsring, samenvatting, opnieuw controleren en de checklist. */
export function SystemCheck({ host, configured }: { host: string | null; configured: boolean }) {
  const t = useT().mail.checks;
  const utils = trpc.useUtils();
  const last = trpc.mail.checks.last.useQuery(undefined, { enabled: configured });
  const run = trpc.mail.checks.run.useMutation({
    onSuccess: (r) => {
      utils.mail.checks.last.setData(undefined, r);
      void utils.mail.status.invalidate();
    },
  });
  const report = last.data ?? null;
  const running = run.isPending;
  const checks = report ? [...report.checks].sort((a, b) => RANK[checkTone(a)] - RANK[checkTone(b)] || CHECK_ORDER.indexOf(a.id) - CHECK_ORDER.indexOf(b.id)) : [];
  const okCount = checks.filter((c) => c.ok).length;
  const failReq = checks.filter((c) => checkTone(c) === "fail").length;
  const warns = checks.filter((c) => checkTone(c) === "warn").length;

  return (
    <Card className="overflow-hidden" data-testid="mail-system-check" aria-busy={running || undefined}>
      <div className="relative flex flex-col gap-4 border-b border-border p-4 sm:flex-row sm:items-center sm:p-5">
        <span aria-hidden className={cn("pointer-events-none absolute -left-10 -top-16 size-48 rounded-full blur-3xl", !report ? "bg-primary/10" : failReq ? "bg-destructive/12" : "bg-success/12")} />
        <div className="relative flex items-center gap-4">
          {report ? (
            <ProgressRing value={okCount} total={checks.length} label={t.ringLabel(okCount, checks.length)} tone={failReq ? (okCount / checks.length >= 0.7 ? "warning" : "destructive") : warns ? "success" : "success"}>
              <div>
                <div className="text-2xl font-bold leading-none tabular-nums" data-testid="mail-check-score">
                  {okCount}
                  <span className="text-sm font-medium text-muted-foreground">/{checks.length}</span>
                </div>
              </div>
            </ProgressRing>
          ) : (
            <span className="grid size-24 shrink-0 place-items-center rounded-full border-8 border-muted text-muted-foreground">
              <ShieldCheck className="size-7" aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">{t.title}</h2>
            {report ? (
              <>
                <p className="font-medium" data-testid="mail-check-summary">
                  {t.summary(okCount, checks.length)}
                </p>
                <p className={cn("text-sm", failReq ? "text-destructive" : warns ? "text-warning" : "text-success")}>
                  {failReq ? t.requiredRed(failReq) : warns ? t.warnings(warns) : t.allGood}
                  {failReq > 0 && warns > 0 && <span className="text-warning"> · {t.warnings(warns)}</span>}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t.neverTitle}</p>
            )}
          </div>
        </div>
        <div className="relative flex flex-col gap-1.5 sm:ml-auto sm:items-end">
          <Button variant={report ? "outline" : "default"} onClick={() => run.mutate()} disabled={running || !configured} data-testid="mail-check-run">
            {running ? <Spinner label={t.running} /> : <RefreshCw />}
            {running ? t.running : report ? t.runAgain : t.runFirst}
          </Button>
          {report && (
            <span className="text-xs text-muted-foreground" data-testid="mail-check-time">
              {t.lastChecked} <RelativeTime date={report.checkedAt} />
            </span>
          )}
        </div>
      </div>
      {run.error && (
        <div className="p-4 pb-0 sm:px-5">
          <Alert variant="destructive">
            <XCircle />
            <AlertDescription className="mt-0">{errorText(run.error)}</AlertDescription>
          </Alert>
        </div>
      )}
      {last.isLoading ? (
        <ul className="divide-y divide-border">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
              <Skeleton className="size-9 rounded-xl" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3.5 w-64 max-w-full" />
              </div>
            </li>
          ))}
        </ul>
      ) : report ? (
        <ul className="divide-y divide-border" data-testid="mail-check-list">
          {checks.map((c, i) => (
            <CheckRow key={c.id} check={c} report={report} host={host} running={running} initiallyOpen={i === 0 && checkTone(c) === "fail"} />
          ))}
        </ul>
      ) : running ? (
        <ul className="divide-y divide-border">
          {CHECK_ORDER.map((id) => {
            const Icon = CHECK_ICON[id];
            return (
              <li key={id} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
                <span className="grid size-9 place-items-center rounded-xl bg-muted text-muted-foreground">
                  <Icon className="size-[18px]" aria-hidden />
                </span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="font-medium">{t.names[id]}</div>
                  <Skeleton className="h-3.5 w-56 max-w-full" />
                </div>
                <Spinner className="size-5 text-muted-foreground" />
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
          <p className="max-w-md text-sm text-muted-foreground">{t.neverText}</p>
        </div>
      )}
    </Card>
  );
}
