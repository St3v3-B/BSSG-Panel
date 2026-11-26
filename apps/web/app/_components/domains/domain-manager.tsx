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
import { DNS_STATUS, providerHelp, RECORD_STATUS, SSL_STATUS, WARNINGS, wwwCounterpart } from "@/app/_lib/dns";

/** Interval van de live DNS-controle zolang het scherm open is (ontwerp: 30 s). */
export const LIVE_CHECK_MS = 30_000;

export function DomainManager({ uuid }: { uuid: string }) {
  const domains = trpc.domains.list.useQuery({ uuid }, { refetchInterval: LIVE_CHECK_MS });
  const target = trpc.domains.target.useQuery({ uuid });
  const list = domains.data ?? [];
  return (
    <div className="max-w-5xl space-y-6" data-testid="domain-manager">
      <AddDomainCard uuid={uuid} existing={list} />
      {target.data && (
        <p className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          Je records wijzen naar <code className="font-mono text-foreground">{target.data.ip}</code>
          <CopyButton value={target.data.ip} label="IP kopiëren" /> (node <code className="font-mono">{target.data.nodeFqdn}</code>).
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
            <p>Nog geen domeinen. Voeg hierboven je domein toe; het panel laat daarna precies zien welke DNS-records nodig zijn.</p>
          </div>
        </Card>
      ) : (
        list.map((d) => <DomainCard key={d.id} uuid={uuid} domain={d} all={list} />)
      )}
    </div>
  );
}

function AddDomainCard({ uuid, existing }: { uuid: string; existing: Domain[] }) {
  const utils = trpc.useUtils();
  const [hostname, setHostname] = useState("");
  const [wildcard, setWildcard] = useState(false);
  const [withWww, setWithWww] = useState(true);
  const [touched, setTouched] = useState(false);
  const add = trpc.domains.add.useMutation();
  const host = hostname.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const parsed = Hostname.safeParse(host);
  const err = !host ? "Vul een domein in" : !parsed.success ? "Ongeldige domeinnaam (bv. mijnsite.nl)" : existing.some((d) => d.hostname === host) ? "Dit domein is al gekoppeld" : null;
  const counterpart = wwwCounterpart(host);
  const offerWww = !wildcard && !host.startsWith("*.") && !existing.some((d) => d.hostname === counterpart);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setTouched(true);
    if (err) return;
    setError(null);
    try {
      // het kale domein serveert de site; www stuurt door (of andersom als je www invult)
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
        <CardTitle className="text-base">Domein koppelen</CardTitle>
        <CardDescription>Na het toevoegen zie je welke records je bij je domeinprovider moet zetten. SSL regelt het panel zelf.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-64 flex-1 space-y-1">
              <Label htmlFor="domain-host" className="sr-only">
                Domein
              </Label>
              <Input id="domain-host" placeholder="mijnsite.nl" value={hostname} onChange={(e) => setHostname(e.target.value)} aria-invalid={(touched && !!err) || undefined} />
              {touched && err && <p className="text-xs text-destructive">{err}</p>}
            </div>
            <Button type="submit" disabled={add.isPending}>
              {add.isPending ? <Spinner /> : <Plus />} Toevoegen
            </Button>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            {offerWww && host && (
              <label className="flex items-center gap-2">
                <Checkbox checked={withWww} onChange={(e) => setWithWww(e.target.checked)} /> Ook <code className="font-mono">{counterpart}</code> laten doorsturen
              </label>
            )}
            <label className="flex items-center gap-2" title="Vereist een gekoppelde DNS-provider (Cloudflare) voor het certificaat">
              <Checkbox checked={wildcard} onChange={(e) => setWildcard(e.target.checked)} /> Wildcard (*.{host || "domein"})
            </label>
          </div>
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

function DomainCard({ uuid, domain, all }: { uuid: string; domain: Domain; all: Domain[] }) {
  const utils = trpc.useUtils();
  const live = useLiveDnsCheck(domain.id);
  const [applied, setApplied] = useState<DnsCheck | null>(null);
  const apply = trpc.domains.applyDns.useMutation({ onSuccess: (r) => setApplied(r) });
  const update = trpc.domains.update.useMutation({ onSuccess: () => void utils.domains.list.invalidate({ uuid }) });
  const remove = trpc.domains.remove.useMutation({ onSuccess: () => void utils.domains.list.invalidate({ uuid }) });
  const [confirm, setConfirm] = useState(false);
  const check = applied && (!live.data || applied.checkedAt >= live.data.checkedAt) ? applied : live.data;
  const ssl = SSL_STATUS[domain.sslStatus];
  const dns = DNS_STATUS[domain.dnsStatus];
  const help = providerHelp(check?.provider ?? "other");
  const others = all.filter((d) => d.id !== domain.id && !d.redirectTo);

  return (
    <Card data-testid="domain-card">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex min-w-0 items-center gap-2 text-base">
            <a href={`https://${domain.hostname.replace(/^\*\./, "")}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 truncate hover:underline">
              {domain.wildcard && "*."}
              {domain.hostname} <ExternalLink className="size-3.5 text-muted-foreground" />
            </a>
            {domain.redirectTo && (
              <span className="inline-flex items-center gap-1 text-sm font-normal text-muted-foreground">
                <ArrowRight className="size-3.5" /> {domain.redirectTo}
              </span>
            )}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={dns.variant}>{dns.label}</Badge>
            <Badge variant={ssl.variant} title={ssl.hint} data-testid="ssl-status">
              {ssl.label}
            </Badge>
          </div>
        </div>
        <CardDescription>{ssl.hint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {check?.warnings.map((w) => (
          <Alert key={w} variant="warning" data-testid={`warning-${w}`}>
            <TriangleAlert />
            <div>
              <AlertTitle>{WARNINGS[w].title}</AlertTitle>
              <AlertDescription>{WARNINGS[w].text}</AlertDescription>
            </div>
          </Alert>
        ))}

        {!check ? (
          <Skeleton className="h-24" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm" data-testid="dns-records">
              <thead className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Type</th>
                  <th className="px-3 py-2 font-medium">Naam</th>
                  <th className="px-3 py-2 font-medium">Waarde</th>
                  <th className="px-3 py-2 font-medium">Nu gevonden</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {check.records.map((r, i) => (
                  <tr key={`${r.type}-${r.name}-${i}`}>
                    <td className="px-3 py-2 font-mono">{r.type}</td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-0.5">
                        <code className="font-mono">{r.name}</code>
                        <CopyButton value={r.name} label={`Naam ${r.name} kopiëren`} />
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {r.expected ? (
                        <span className="inline-flex items-center gap-0.5">
                          <code className="font-mono">{r.expected}</code>
                          <CopyButton value={r.expected} label={`Waarde ${r.expected} kopiëren`} />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">verwijderen</span>
                      )}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{r.actual.length ? r.actual.join(", ") : "–"}</td>
                    <td className="px-3 py-2">
                      <Badge variant={RECORD_STATUS[r.status].variant}>{RECORD_STATUS[r.status].label}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {check && check.records.some((r) => r.status !== "ok") && (
          <details className="rounded-lg border border-border p-3 text-sm" open={domain.dnsStatus !== "ok"} data-testid="provider-help">
            <summary className="cursor-pointer font-medium">Zo zet je de records bij {help.name}</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
              {help.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {check.nameservers.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Nameservers: <code className="font-mono">{check.nameservers.join(", ")}</code>
              </p>
            )}
          </details>
        )}

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Button size="sm" variant="outline" onClick={live.recheck} disabled={live.checking}>
            <RefreshCw className={live.checking ? "animate-spin" : undefined} /> Opnieuw controleren
          </Button>
          {domain.dnsProviderId != null && (
            <Button size="sm" variant="outline" onClick={() => apply.mutate({ id: domain.id })} disabled={apply.isPending}>
              {apply.isPending ? <Spinner /> : <Wand2 />} Records automatisch zetten
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            {check ? `Gecontroleerd ${formatDate(check.checkedAt)} · elke 30 s` : "Controleren…"}
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Label htmlFor={`redirect-${domain.id}`} className="text-xs text-muted-foreground">
              Doorsturen naar
            </Label>
            <Select
              id={`redirect-${domain.id}`}
              className="h-8 w-auto"
              value={domain.redirectTo ?? ""}
              disabled={update.isPending}
              onChange={(e) => update.mutate({ id: domain.id, targetPort: domain.targetPort, redirectTo: e.target.value || null })}
            >
              <option value="">niet (site tonen)</option>
              {others.map((o) => (
                <option key={o.id} value={o.hostname}>
                  {o.hostname}
                </option>
              ))}
            </Select>
            {confirm ? (
              <>
                <Button size="sm" variant="destructive" onClick={() => remove.mutate({ id: domain.id })} disabled={remove.isPending}>
                  {remove.isPending && <Spinner />} Ontkoppelen
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                  Annuleren
                </Button>
              </>
            ) : (
              <Button size="icon-sm" variant="ghost" aria-label={`${domain.hostname} ontkoppelen`} onClick={() => setConfirm(true)}>
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
