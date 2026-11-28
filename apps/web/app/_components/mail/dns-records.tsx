"use client";
import { AlertTriangle, CheckCircle2, CircleDashed, Cloud, RefreshCw, Server, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import type { MailDnsRecord, MailDnsRecords } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";
import { CopyPill, CopyValue, ProgressRing, RelativeTime } from "./primitives";

const TYPE_STYLE: Record<MailDnsRecord["type"], string> = {
  MX: "bg-primary/15 text-primary ring-primary/25",
  TXT: "bg-info/12 text-info ring-info/25",
  A: "bg-success/12 text-success ring-success/25",
  AAAA: "bg-success/12 text-success ring-success/25",
  PTR: "bg-warning/12 text-warning ring-warning/25",
};

export const AUTO_CHECK_MS = 20_000;

function StatusPill({ status, animate }: { status: MailDnsRecord["status"]; animate: boolean }) {
  const t = useT().mail.dns.status;
  const cls = {
    ok: "border-success/30 bg-success/10 text-success",
    missing: "border-destructive/30 bg-destructive/10 text-destructive",
    wrong: "border-warning/30 bg-warning/10 text-warning",
    unchecked: "border-border bg-muted text-muted-foreground",
  }[status];
  const Icon = { ok: CheckCircle2, missing: XCircle, wrong: AlertTriangle, unchecked: CircleDashed }[status];
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium", cls)} data-testid="dns-status" data-status={status}>
      <span className="relative inline-flex">
        {animate && <span aria-hidden className="absolute inset-0 animate-[ring-burst_0.8s_ease-out] rounded-full bg-success/50" />}
        <Icon key={status} className={cn("relative size-3.5", animate && "animate-[pop_0.45s_cubic-bezier(0.2,0.8,0.2,1.4)]")} aria-hidden />
      </span>
      {t[status]}
    </span>
  );
}

function RecordCard({ r, justOk }: { r: MailDnsRecord; justOk: boolean }) {
  const t = useT().mail.dns;
  const ok = r.status === "ok";
  return (
    <li
      className={cn(
        "relative rounded-xl border bg-card/60 p-3.5 transition-[border-color,background-color,box-shadow] duration-500 sm:p-4",
        ok ? "border-success/30 bg-success/[0.03]" : r.status === "missing" ? "border-border" : r.status === "wrong" ? "border-warning/30" : "border-border",
        justOk && "shadow-[0_0_0_4px] shadow-success/10",
      )}
      data-testid={`dns-record-${r.id}`}
    >
      <div className="flex items-start gap-3">
        <span className={cn("inline-flex h-7 min-w-12 shrink-0 items-center justify-center rounded-lg px-2 font-mono text-xs font-bold ring-1 ring-inset", TYPE_STYLE[r.type])}>{r.type}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-medium">{t.purpose[r.id]}</span>
            {!r.required && <Badge variant="secondary" className="text-[11px] font-normal">{t.recommended}</Badge>}
          </div>
        </div>
        <StatusPill status={r.status} animate={justOk} />
      </div>
      <dl className="mt-3 space-y-2.5">
        <div className="grid gap-1 sm:grid-cols-[5.5rem_1fr] sm:items-center sm:gap-3">
          <dt className="text-xs text-muted-foreground">{t.name}</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 font-mono text-xs" title={r.name}>
              {r.name}
            </code>
            <CopyPill value={r.name} label={t.copyName(r.name)} />
          </dd>
        </div>
        {r.priority != null && (
          <div className="grid gap-1 sm:grid-cols-[5.5rem_1fr] sm:items-center sm:gap-3">
            <dt className="text-xs text-muted-foreground">{t.priority}</dt>
            <dd>
              <code className="rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 font-mono text-xs">{r.priority}</code>
            </dd>
          </div>
        )}
        <div className="grid gap-1 sm:grid-cols-[5.5rem_1fr] sm:items-start sm:gap-3">
          <dt className="text-xs text-muted-foreground sm:pt-2">{t.value}</dt>
          <dd className="min-w-0">
            <CopyValue value={r.value} label={t.copyValue(r.type)} clampAt={60} />
          </dd>
        </div>
        {r.status === "wrong" && r.actual.length > 0 && (
          <div className="grid gap-1 sm:grid-cols-[5.5rem_1fr] sm:gap-3">
            <dt className="text-xs text-warning">{t.found}</dt>
            <dd className="min-w-0 space-y-1">
              {r.actual.map((a) => (
                <code key={a} className="block truncate font-mono text-xs text-muted-foreground line-through decoration-warning/60" title={a}>
                  {a}
                </code>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </li>
  );
}

/** Gesegmenteerde voortgangsbalk: één segment per record. */
function Segments({ records }: { records: MailDnsRecord[] }) {
  return (
    <div className="flex gap-1" aria-hidden>
      {records.map((r) => (
        <span
          key={r.id}
          className={cn("h-1.5 flex-1 rounded-full transition-colors duration-500", r.status === "ok" ? "bg-success" : r.status === "wrong" ? "bg-warning" : r.status === "missing" ? "bg-destructive/50" : "bg-muted")}
        />
      ))}
    </div>
  );
}

/** Houdt bij welke records sinds de vorige data groen zijn geworden (voor de animatie). */
function useJustOk(data: MailDnsRecords | undefined) {
  const prev = useRef<Map<string, string> | null>(null);
  const just = useRef<Set<string>>(new Set());
  const key = data ? data.records.map((r) => `${r.id}:${r.status}`).join(",") : "";
  if (data) {
    const map = new Map(data.records.map((r) => [r.id, r.status]));
    if (prev.current && key !== [...prev.current].map(([k, v]) => `${k}:${v}`).join(",")) {
      just.current = new Set(data.records.filter((r) => r.status === "ok" && prev.current!.get(r.id) !== "ok").map((r) => r.id));
    }
    prev.current = map;
  }
  return just.current;
}

/** DNS-records van een maildomein met kopieerknoppen, live status en automatische hercontrole. */
export function DnsRecords({ domainId, auto = true, compact = false }: { domainId: number; auto?: boolean; compact?: boolean }) {
  const t = useT().mail.dns;
  const utils = trpc.useUtils();
  const q = trpc.mail.domains.dnsRecords.useQuery({ id: domainId });
  const onData = (d: MailDnsRecords) => {
    utils.mail.domains.dnsRecords.setData({ id: domainId }, d);
    void utils.mail.domains.list.invalidate();
    void utils.mail.domains.get.invalidate({ id: domainId });
  };
  const check = trpc.mail.domains.checkDns.useMutation({ onSuccess: onData });
  const apply = trpc.mail.domains.applyDns.useMutation({ onSuccess: onData });
  const data = q.data;
  const just = useJustOk(data);
  const dnsRecs = data?.records.filter((r) => r.where === "dns") ?? [];
  const hostRecs = data?.records.filter((r) => r.where === "hosting") ?? [];
  const okCount = dnsRecs.filter((r) => r.status === "ok").length;
  const allOk = dnsRecs.length > 0 && okCount === dnsRecs.length;

  // Live: controleer elke 20 s zolang niet alles klopt en het tabblad zichtbaar is; ook direct bij openen als nog nooit gecontroleerd.
  const checkRef = useRef(check);
  checkRef.current = check;
  const neverChecked = data?.checkedAt === null;
  useEffect(() => {
    if (!auto || !data || allOk) return;
    if (neverChecked && !checkRef.current.isPending) checkRef.current.mutate({ id: domainId });
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && !checkRef.current.isPending) checkRef.current.mutate({ id: domainId });
    }, AUTO_CHECK_MS);
    return () => clearInterval(id);
  }, [auto, allOk, domainId, !!data, neverChecked]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.error) return <QueryError error={q.error} />;
  if (!data)
    return (
      <div className="space-y-3" aria-busy>
        <Skeleton className="h-20 rounded-2xl" />
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
      </div>
    );

  return (
    <div className="space-y-4" data-testid="dns-records">
      <Card className={cn("relative overflow-hidden p-4 sm:p-5", compact && "shadow-none")}>
        <span aria-hidden className={cn("pointer-events-none absolute -right-10 -top-16 size-48 rounded-full blur-3xl transition-colors duration-700", allOk ? "bg-success/15" : "bg-primary/10")} />
        <div className="relative flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2.5">
              {allOk ? (
                <span className="grid size-7 place-items-center rounded-full bg-success/15 text-success">
                  <CheckCircle2 className="size-4 animate-[pop_0.45s_ease-out]" aria-hidden />
                </span>
              ) : (
                <ProgressRing value={okCount} total={dnsRecs.length} size={28} stroke={4} tone={okCount === 0 ? "muted" : "warning"} label={t.progress(okCount, dnsRecs.length)} />
              )}
              <span className={cn("font-semibold", allOk && "text-success")} data-testid="dns-progress" aria-live="polite">
                {allOk ? t.allOk : t.progress(okCount, dnsRecs.length)}
              </span>
            </div>
            <Segments records={dnsRecs} />
            <p className="text-xs text-muted-foreground">
              {data.checkedAt ? (
                <>
                  {t.lastChecked} <RelativeTime date={data.checkedAt} />
                </>
              ) : (
                t.notChecked
              )}
              {auto && !allOk && <> · {t.autoCheck}</>}
            </p>
          </div>
          <Button variant="outline" onClick={() => check.mutate({ id: domainId })} disabled={check.isPending} data-testid="dns-check">
            {check.isPending ? <Spinner label={t.checking} /> : <RefreshCw />}
            {check.isPending ? t.checking : t.checkAgain}
          </Button>
        </div>
        {(check.error || apply.error) && <p className="relative mt-3 text-sm text-destructive">{errorText(check.error ?? apply.error)}</p>}
      </Card>

      {data.cloudflare && !allOk && (
        <Alert variant="info" data-testid="dns-cloudflare">
          <Cloud />
          <div className="flex-1">
            <AlertDescription className="mt-0">{t.cloudflare(data.cloudflare.zone)}</AlertDescription>
          </div>
          <Button size="sm" onClick={() => apply.mutate({ id: domainId })} disabled={apply.isPending}>
            {apply.isPending ? <Spinner /> : <Cloud />} {t.applyCloudflare}
          </Button>
        </Alert>
      )}
      {apply.isSuccess && <p className="text-sm text-success" role="status">{t.applied}</p>}

      <section className="space-y-2.5">
        <div>
          <h3 className="text-sm font-semibold">{t.atDns}</h3>
          <p className="text-xs text-muted-foreground">{t.atDnsText}</p>
        </div>
        <ul className="space-y-2.5">
          {dnsRecs.map((r) => (
            <RecordCard key={r.id} r={r} justOk={just.has(r.id)} />
          ))}
        </ul>
      </section>
      {hostRecs.length > 0 && (
        <section className="space-y-2.5">
          <div>
            <h3 className="flex items-center gap-1.5 text-sm font-semibold">
              <Server className="size-4 text-muted-foreground" aria-hidden /> {t.atHosting}
            </h3>
            <p className="text-xs text-muted-foreground">{t.atHostingText}</p>
          </div>
          <ul className="space-y-2.5">
            {hostRecs.map((r) => (
              <RecordCard key={r.id} r={r} justOk={just.has(r.id)} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function DnsStatusBadge({ status }: { status: MailDnsRecords["dnsStatus"] }) {
  const t = useT().mail.dns.dnsStatus;
  const v = status === "ok" ? "success" : status === "pending" ? "warning" : "destructive";
  const Icon = status === "ok" ? CheckCircle2 : status === "pending" ? CircleDashed : XCircle;
  return (
    <Badge variant={v} data-testid="dns-badge" data-status={status}>
      <Icon /> {t[status]}
    </Badge>
  );
}
