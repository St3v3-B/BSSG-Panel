"use client";
import { ArrowRight, ExternalLink, Globe, Plus, RefreshCw, Trash2, TriangleAlert, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DnsCheck, Domain } from "@panel/api";
import { Hostname } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { dnsStatus, providerHelp, recordStatus, sslStatus, warningText, wwwCounterpart } from "@/app/_lib/dns";
import { useT } from "@/app/_lib/i18n";
import { Table } from "@/app/_components/ui/table";

/** Interval van de live DNS-controle zolang het scherm open is (ontwerp: 30 s). */
export const LIVE_CHECK_MS = 30_000;

export function DomainManager({ uuid, isWeb = true }: { uuid: string; isWeb?: boolean }) {
  const domains = trpc.domains.list.useQuery({ uuid }, { refetchInterval: LIVE_CHECK_MS });
  const target = trpc.domains.target.useQuery({ uuid });
  const list = domains.data ?? [];
  const t = useT();
  return (
    <div className="max-w-5xl space-y-6" data-testid="domain-manager">
      <AddDomainCard uuid={uuid} existing={list} isWeb={isWeb} />
      {target.data && (
        <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          {t.domains.pointTo} <code className="font-mono text-foreground">{target.data.ip}</code>
          <CopyButton value={target.data.ip} label={t.domains.copyIp} /> {target.data.relayFqdn ? t.domains.viaRelay(target.data.nodeFqdn, target.data.relayFqdn) : t.domains.node(target.data.nodeFqdn)}
          {target.data.gameIp && target.data.gameIp !== target.data.ip && !isWeb && (
            <span data-testid="domain-game-ip">
              {" "}
              {t.domains.gameIp} <code className="font-mono text-foreground">{target.data.gameIp}</code>
            </span>
          )}
        </p>
      )}
      {domains.error ? (
        <QueryError error={domains.error} />
      ) : domains.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : list.length === 0 ? (
        <Card className="grid min-h-40 place-items-center p-6 text-center text-sm text-muted-foreground">
          <div className="space-y-2">
            <Globe className="mx-auto size-6" />
            <p>{t.domains.empty}</p>
          </div>
        </Card>
      ) : (
        list.map((d) => <DomainCard key={d.id} uuid={uuid} domain={d} all={list} isWeb={isWeb} />)
      )}
    </div>
  );
}

function AddDomainCard({ uuid, existing, isWeb }: { uuid: string; existing: Domain[]; isWeb: boolean }) {
  const utils = trpc.useUtils();
  const t = useT();
  const [hostname, setHostname] = useState("");
  const [wildcard, setWildcard] = useState(false);
  const [withWww, setWithWww] = useState(true);
  const [touched, setTouched] = useState(false);
  const [protocol, setProtocol] = useState<"http" | "minecraft">("http");
  const [port, setPort] = useState("");
  const add = trpc.domains.add.useMutation();
  const host = hostname.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const parsed = Hostname.safeParse(host);
  const mc = !isWeb && protocol === "minecraft";
  const portNum = Number(port);
  const portOk = Number.isInteger(portNum) && portNum >= 1 && portNum <= 65535;
  const err = !host
    ? t.domains.required
    : !parsed.success
      ? t.domains.invalid
      : existing.some((d) => d.hostname === host)
        ? t.domains.taken
        : mc && existing.some((d) => d.protocol === "minecraft")
          ? t.domains.minecraftExists
          : !isWeb && !mc && !portOk
            ? t.domains.portInvalid
            : null;
  const counterpart = wwwCounterpart(host);
  const offerWww = !wildcard && !host.startsWith("*.") && !existing.some((d) => d.hostname === counterpart);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setTouched(true);
    if (err) return;
    setError(null);
    try {
      // het kale domein serveert de site; www stuurt door (of andersom als je www invult)
      if (!isWeb) {
        await add.mutateAsync(mc ? { uuid, hostname: host, protocol: "minecraft" } : { uuid, hostname: host, protocol: "http", targetPort: portNum });
        setHostname("");
        setPort("");
        setTouched(false);
        return;
      }
      await add.mutateAsync({ uuid, hostname: host, wildcard });
      if (offerWww && withWww && Hostname.safeParse(counterpart).success) await add.mutateAsync({ uuid, hostname: counterpart, redirectTo: host });
      setHostname("");
      setTouched(false);
    } catch (e) {
      setError(e);
    } finally {
      void utils.domains.list.invalidate({ uuid });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.domains.addTitle}</CardTitle>
        <CardDescription>{t.domains.addText}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          data-testid="add-domain-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {!isWeb && (
            <div className="flex flex-wrap items-start gap-3">
              <div className="space-y-1">
                <Label htmlFor="domain-protocol">{t.domains.protocol}</Label>
                <Select id="domain-protocol" value={protocol} onChange={(e) => setProtocol(e.target.value as "http" | "minecraft")}>
                  <option value="http">{t.domains.protocolHttp}</option>
                  <option value="minecraft">{t.domains.protocolMinecraft}</option>
                </Select>
              </div>
              {!mc && (
                <div className="space-y-1">
                  <Label htmlFor="domain-port">{t.domains.port}</Label>
                  <Input id="domain-port" inputMode="numeric" className="w-28" placeholder="8123" value={port} onChange={(e) => setPort(e.target.value)} />
                </div>
              )}
              <p className="min-w-48 flex-1 self-end pb-2 text-xs text-muted-foreground">{mc ? t.domains.minecraftHint : t.domains.portHint}</p>
            </div>
          )}
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-64 flex-1 space-y-1">
              <Label htmlFor="domain-host" className="sr-only">
                {t.domains.domain}
              </Label>
              <Input id="domain-host" placeholder={t.domains.placeholder} value={hostname} onChange={(e) => setHostname(e.target.value)} aria-invalid={(touched && !!err) || undefined} />
              {touched && err && <p className="text-xs text-destructive">{err}</p>}
            </div>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? <Spinner /> : <Plus />} {t.common.add}
            </Button>
          </div>
          {isWeb && (
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {offerWww && host && (
              <label className="flex items-center gap-2">
                <Checkbox checked={withWww} onChange={(e) => setWithWww(e.target.checked)} /> {t.domains.alsoRedirect} <code className="font-mono">{counterpart}</code> {t.domains.alsoRedirectSuffix}
              </label>
            )}
            <label className="flex items-center gap-2" title={t.domains.wildcardHint}>
              <Checkbox checked={wildcard} onChange={(e) => setWildcard(e.target.checked)} /> {t.domains.wildcard(host || t.domains.domainFallback)}
            </label>
          </div>
          )}
          {error != null && <p className="text-sm text-destructive">{errorText(error)}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

/** Live DNS-controle: eerst de laatste check, daarna elke 30 s opnieuw zolang het tabblad zichtbaar is. */
export function useLiveDnsCheck(domainId: number, intervalMs = LIVE_CHECK_MS) {
  const last = trpc.domains.lastCheck.useQuery({ id: domainId }, { retry: false });
  const check = trpc.domains.check.useMutation();
  const mutateRef = useRef(check.mutate);
  mutateRef.current = check.mutate;
  useEffect(() => {
    const run = () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") mutateRef.current({ id: domainId });
    };
    run();
    const t = setInterval(run, intervalMs);
    return () => clearInterval(t);
  }, [domainId, intervalMs]);
  return { data: check.data ?? last.data ?? null, checking: check.isPending, error: check.error, recheck: () => check.mutate({ id: domainId }) };
}

function DomainCard({ uuid, domain, all, isWeb }: { uuid: string; domain: Domain; all: Domain[]; isWeb: boolean }) {
  const utils = trpc.useUtils();
  const t = useT();
  const live = useLiveDnsCheck(domain.id);
  const [applied, setApplied] = useState<DnsCheck | null>(null);
  const apply = trpc.domains.applyDns.useMutation({ onSuccess: (r) => setApplied(r) });
  const update = trpc.domains.update.useMutation({ onSuccess: () => void utils.domains.list.invalidate({ uuid }) });
  const remove = trpc.domains.remove.useMutation({ onSuccess: () => void utils.domains.list.invalidate({ uuid }) });
  const [confirm, setConfirm] = useState(false);
  const check = applied && (!live.data || applied.checkedAt >= live.data.checkedAt) ? applied : live.data;
  const ssl = sslStatus(domain.sslStatus);
  const dns = dnsStatus(domain.dnsStatus);
  const help = providerHelp(check?.provider ?? "other");
  const mc = domain.protocol === "minecraft";
  const others = all.filter((d) => d.id !== domain.id && !d.redirectTo);

  return (
    <Card data-testid="domain-card">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex min-w-0 items-center gap-2 text-base">
            {mc ? (
              <span className="truncate">{domain.hostname}</span>
            ) : (
              <a href={`https://${domain.hostname.replace(/^\*\./, "")}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 truncate hover:underline">
                {domain.wildcard && "*."}
                {domain.hostname} <ExternalLink className="size-3.5 text-muted-foreground" />
              </a>
            )}
            {!isWeb && (
              <Badge variant="outline" data-testid="domain-protocol">
                {mc ? t.domains.protocolMinecraft : t.domains.httpPort(domain.targetPort ?? 0)}
              </Badge>
            )}
            {domain.redirectTo && (
              <span className="inline-flex items-center gap-1 text-sm font-normal text-muted-foreground">
                <ArrowRight className="size-3.5" /> {domain.redirectTo}
              </span>
            )}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={dns.variant}>{dns.label}</Badge>
            {!mc && (
              <Badge variant={ssl.variant} title={ssl.hint} data-testid="ssl-status">
                {ssl.label}
              </Badge>
            )}
          </div>
        </div>
        <CardDescription>{mc ? t.domains.minecraftJoin(domain.hostname) : ssl.hint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {check?.warnings.map((w) => (
          <Alert key={w} variant="warning" data-testid={`warning-${w}`}>
            <TriangleAlert />
            <div>
              <AlertTitle>{warningText(w).title}</AlertTitle>
              <AlertDescription>{warningText(w).text}</AlertDescription>
            </div>
          </Alert>
        ))}

        {!check ? (
          <Skeleton className="h-24" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table data-testid="dns-records">
              <thead className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t.domains.colType}</th>
                  <th className="px-3 py-2 font-medium">{t.domains.colName}</th>
                  <th className="px-3 py-2 font-medium">{t.domains.colValue}</th>
                  <th className="px-3 py-2 font-medium">{t.domains.colFound}</th>
                  <th className="px-3 py-2 font-medium">{t.domains.colStatus}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {check.records.map((r, i) => (
                  <tr key={`${r.type}-${r.name}-${i}`}>
                    <td className="px-3 py-2 font-mono">{r.type}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-0.5">
                        <code className="font-mono">{r.name}</code>
                        <CopyButton value={r.name} label={t.domains.copyName(r.name)} />
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {r.expected ? (
                        <span className="inline-flex items-center gap-0.5">
                          <code className="font-mono">{r.expected}</code>
                          <CopyButton value={r.expected} label={t.domains.copyValue(r.expected)} />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">{t.domains.remove}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.actual.length ? r.actual.join(", ") : "–"}</td>
                    <td className="px-3 py-2">
                      <Badge variant={recordStatus(r.status).variant}>{recordStatus(r.status).label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}

        {check && check.records.some((r) => r.status !== "ok") && (
          <details className="rounded-lg border border-border p-3 text-sm" open={domain.dnsStatus !== "ok"} data-testid="provider-help">
            <summary className="cursor-pointer font-medium">{t.domains.howTo(help.name)}</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
              {help.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {check.nameservers.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t.domains.nameservers} <code className="font-mono">{check.nameservers.join(", ")}</code>
              </p>
            )}
          </details>
        )}

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button size="sm" variant="outline" onClick={live.recheck} disabled={live.checking}>
            <RefreshCw className={live.checking ? "animate-spin" : undefined} /> {t.domains.recheck}
          </Button>
          {domain.dnsProviderId != null && (
            <Button size="sm" variant="outline" onClick={() => apply.mutate({ id: domain.id })} disabled={apply.isPending}>
              {apply.isPending ? <Spinner /> : <Wand2 />} {t.domains.apply}
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {check ? t.domains.checkedAt(formatDate(check.checkedAt)) : t.domains.checking}
          </span>
          <div className="ml-auto flex items-center gap-2">
            {isWeb && (
            <>
            <Label htmlFor={`redirect-${domain.id}`} className="text-xs text-muted-foreground">
              {t.domains.redirectTo}
            </Label>
            <Select
              id={`redirect-${domain.id}`}
              className="h-8 w-auto"
              value={domain.redirectTo ?? ""}
              disabled={update.isPending}
              onChange={(e) => update.mutate({ id: domain.id, targetPort: domain.targetPort, redirectTo: e.target.value || null })}
            >
              <option value="">{t.domains.noRedirect}</option>
              {others.map((o) => (
                <option key={o.id} value={o.hostname}>
                  {o.hostname}
                </option>
              ))}
            </Select>
            </>
            )}
            {confirm ? (
              <>
                <Button size="sm" variant="destructive" onClick={() => remove.mutate({ id: domain.id })} disabled={remove.isPending}>
                  {remove.isPending && <Spinner />} {t.domains.disconnect}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                  {t.common.cancel}
                </Button>
              </>
            ) : (
              <Button size="icon-sm" variant="ghost" aria-label={t.domains.disconnectX(domain.hostname)} onClick={() => setConfirm(true)}>
                <Trash2 />
              </Button>
            )}
          </div>
        </div>
        {[live.error, apply.error, update.error, remove.error].filter(Boolean).map((e, i) => (
          <p key={i} className="text-sm text-destructive">
            {errorText(e)}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}
