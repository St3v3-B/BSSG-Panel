"use client";
import { ArrowRightLeft, ExternalLink, Wrench, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { Evacuation, EvacuationItem, EvacuationPlanItem, Node } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge, type BadgeVariant } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { fromLocalInput, toLocalInput } from "@/app/_lib/amsterdam-time";
import { formatDate, formatMb } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { AdminError } from "./nodes";

const ITEM_VARIANT: Record<EvacuationItem["status"], BadgeVariant> = { queued: "secondary", running: "info", done: "success", failed: "destructive", cancelled: "outline" };

/** Onderhoudsmodus + evacueren op de node-detailpagina. */
export function NodeMaintenance({ node }: { node: Node }) {
  const t = useT().hostops.maint;
  const utils = trpc.useUtils();
  const m = node.maintenance ?? null;
  const [message, setMessage] = useState(m?.message ?? "");
  const [start, setStart] = useState(toLocalInput(m?.plannedStart));
  const [end, setEnd] = useState(toLocalInput(m?.plannedEnd));
  const [notifyOwners, setNotifyOwners] = useState(true);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const refresh = () => {
    void utils.admin.nodes.get.invalidate({ id: node.id });
    void utils.admin.nodes.list.invalidate();
    void utils.admin.maintenance.evacuation.invalidate({ id: node.id });
  };
  const set = trpc.admin.maintenance.set.useMutation({ onSuccess: refresh });
  const stop = trpc.admin.maintenance.end.useMutation({ onSuccess: () => (setConfirmEnd(false), refresh()) });
  const startDate = fromLocalInput(start);
  const endDate = fromLocalInput(end);
  const orderErr = startDate && endDate && endDate <= startDate ? t.endBeforeStart : null;

  return (
    <Card data-testid="node-maintenance">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Wrench className="size-4" /> {t.title}
          {m && <Badge variant="warning">{t.active}</Badge>}
        </CardTitle>
        <CardDescription>{m ? t.activeSince(formatDate(m.since)) : t.text}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (orderErr) return;
            set.mutate({ id: node.id, message: message.trim() || null, plannedStart: startDate, plannedEnd: endDate, notifyOwners });
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="maint-message">{t.message}</Label>
            <textarea id="maint-message" className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" maxLength={1000} value={message} placeholder={t.messagePlaceholder} onChange={(e) => setMessage(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="maint-start">{t.plannedStart}</Label>
              <Input id="maint-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="maint-end">{t.plannedEnd}</Label>
              <Input id="maint-end" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t.tzHint}</p>
          {orderErr && <p className="text-sm text-destructive">{orderErr}</p>}
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={notifyOwners} onChange={(e) => setNotifyOwners(e.target.checked)} /> {t.notifyOwners}
          </label>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={set.isPending || !!orderErr} variant={m ? "outline" : "default"}>
              {set.isPending && <Spinner />} {m ? t.update : t.enable}
            </Button>
            {m &&
              (confirmEnd ? (
                <>
                  <Button type="button" onClick={() => stop.mutate({ id: node.id })} disabled={stop.isPending}>
                    {stop.isPending && <Spinner />} {t.endConfirm}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setConfirmEnd(false)}>
                    {t.cancel}
                  </Button>
                </>
              ) : (
                <Button type="button" variant="outline" onClick={() => setConfirmEnd(true)}>
                  {t.end}
                </Button>
              ))}
          </div>
          {confirmEnd && <p className="text-sm text-muted-foreground">{t.endText}</p>}
          {set.isSuccess && <p className="text-sm text-success" role="status">{t.saved}</p>}
          {(set.error || stop.error) && <AdminError error={set.error ?? stop.error} />}
        </form>
        <Evacuate node={node} />
      </CardContent>
    </Card>
  );
}

function Evacuate({ node }: { node: Node }) {
  const t = useT().hostops.maint;
  const utils = trpc.useUtils();
  const ev = trpc.admin.maintenance.evacuation.useQuery({ id: node.id }, { refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false) });
  const running = ev.data?.status === "running";
  const [planning, setPlanning] = useState(false);
  // Klaar met lopen: nodelijst en servers verversen.
  useEffect(() => {
    if (ev.data && ev.data.status !== "running") {
      void utils.admin.servers.list.invalidate();
      void utils.admin.nodes.get.invalidate({ id: node.id });
    }
  }, [ev.data?.status, ev.data, utils, node.id]);
  if (!node.maintenance && !ev.data) return null;
  return (
    <div className="space-y-3 border-t border-border pt-4" data-testid="evacuation">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ArrowRightLeft className="size-4" /> {t.evacTitle}
        </h3>
        {node.maintenance && !running && !planning && (
          <Button size="sm" onClick={() => setPlanning(true)} data-testid="evac-plan">
            {t.evacPlan}
          </Button>
        )}
      </div>
      {!node.maintenance && !running ? null : <p className="text-sm text-muted-foreground">{t.evacText}</p>}
      {ev.error && <QueryError error={ev.error} />}
      {planning && !running && <EvacuationPlanner nodeId={node.id} onStarted={() => setPlanning(false)} onCancel={() => setPlanning(false)} />}
      {ev.data && <EvacuationProgress ev={ev.data} />}
    </div>
  );
}

function EvacuationPlanner({ nodeId, onStarted, onCancel }: { nodeId: number; onStarted: () => void; onCancel: () => void }) {
  const t = useT().hostops.maint;
  const utils = trpc.useUtils();
  const plan = trpc.admin.maintenance.plan.useQuery({ id: nodeId });
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [concurrency, setConcurrency] = useState(1);
  const go = trpc.admin.maintenance.evacuate.useMutation({
    onSuccess: (data) => {
      utils.admin.maintenance.evacuation.setData({ id: nodeId }, data);
      onStarted();
    },
  });
  const items = useMemo(() => plan.data?.items ?? [], [plan.data]);
  const isPicked = (i: EvacuationPlanItem) => picked[i.uuid] ?? true;
  const chosen = items.filter(isPicked);
  if (plan.error) return <QueryError error={plan.error} />;
  if (!plan.data) return <Skeleton className="h-24" />;
  if (!items.length) return <p className="text-sm text-muted-foreground">{t.noServers}</p>;
  return (
    <div className="space-y-3" data-testid="evac-planner">
      <ul className="divide-y divide-border rounded-md border border-border text-sm">
        {items.map((i) => {
          const sug = i.targets.find((x) => x.nodeId === i.suggestedNodeId);
          return (
            <li key={i.uuid} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
              <label className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                <Checkbox checked={isPicked(i)} onChange={(e) => setPicked((p) => ({ ...p, [i.uuid]: e.target.checked }))} aria-label={i.name} />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{i.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {[i.ownerName, formatMb(i.ramMb), i.type === "web" ? t.website : t.ports(i.allocations), i.hasDomains ? t.hasDomains : null].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </label>
              <div className="w-full sm:w-56">
                <label htmlFor={`evac-target-${i.uuid}`} className="sr-only">
                  {t.target}
                </label>
                <Select id={`evac-target-${i.uuid}`} value={targets[i.uuid] ?? ""} onChange={(e) => setTargets((p) => ({ ...p, [i.uuid]: e.target.value }))}>
                  <option value="">{sug ? t.auto(sug.name) : t.autoNone}</option>
                  {i.targets.map((x) => (
                    <option key={x.nodeId} value={x.nodeId} disabled={!x.fits}>
                      {x.name}
                      {x.fits ? (x.freeRamMb === null ? "" : ` (${formatMb(x.freeRamMb)} ${t.free})`) : ` – ${t.reasons[x.reason as keyof typeof t.reasons] ?? x.reason}`}
                    </option>
                  ))}
                </Select>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="evac-concurrency">{t.concurrency}</Label>
          <Select id="evac-concurrency" value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))} className="w-24">
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
        <Button disabled={!chosen.length || go.isPending} onClick={() => go.mutate({ id: nodeId, concurrency, items: chosen.map((i) => ({ uuid: i.uuid, nodeId: targets[i.uuid] ? Number(targets[i.uuid]) : null })) })} data-testid="evac-start">
          {go.isPending && <Spinner />} {t.start(chosen.length)}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t.cancel}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{t.startHint}</p>
      {go.error && <AdminError error={go.error} />}
    </div>
  );
}

function EvacuationProgress({ ev }: { ev: Evacuation }) {
  const t = useT().hostops.maint;
  const utils = trpc.useUtils();
  const cancel = trpc.admin.maintenance.cancel.useMutation({ onSuccess: (d) => utils.admin.maintenance.evacuation.setData({ id: ev.nodeId }, d) });
  const n = (s: EvacuationItem["status"]) => ev.items.filter((i) => i.status === s).length;
  const finished = n("done") + n("failed") + n("cancelled");
  return (
    <div className="space-y-3" data-testid="evac-progress">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant={ev.status === "running" ? "info" : ev.status === "completed" ? "success" : "outline"}>{t.evStatus[ev.status]}</Badge>
        <span className="text-muted-foreground">{t.progress(finished, ev.items.length, n("failed"))}</span>
        <span className="text-xs text-muted-foreground">{formatDate(ev.createdAt)}</span>
        {ev.status === "running" && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => cancel.mutate({ id: ev.nodeId })} disabled={cancel.isPending}>
            <X /> {t.cancelRest}
          </Button>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
        <div className="h-full bg-primary transition-all" style={{ width: `${ev.items.length ? Math.round((finished * 100) / ev.items.length) : 0}%` }} />
      </div>
      <ul className="divide-y divide-border rounded-md border border-border text-sm">
        {ev.items.map((i) => (
          <li key={i.id} className="space-y-1 px-3 py-2" data-testid="evac-item" data-status={i.status}>
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/admin/servers/${i.serverUuid}`} className="min-w-0 truncate font-medium hover:underline">
                {i.serverName}
              </Link>
              <Badge variant={ITEM_VARIANT[i.status]}>{t.itemStatus[i.status]}</Badge>
              {i.status === "running" && <Spinner className="size-3" />}
              <span className="text-xs text-muted-foreground">→ {i.targetNodeName ?? (i.auto ? t.autoShort : "–")}</span>
            </div>
            {i.error && <p className="break-words text-xs text-destructive">{i.error}</p>}
            {i.newAddress && (
              <p className="text-xs text-muted-foreground">
                {t.newAddress} <code className="break-all font-mono text-foreground">{i.newAddress}</code>
              </p>
            )}
            {i.dns.length > 0 && (
              <div className="space-y-1 text-xs">
                <p className="text-muted-foreground">{t.dnsTitle}</p>
                <ul className="space-y-0.5">
                  {i.dns.map((r) => (
                    <li key={`${r.type}:${r.hostname}`} className="flex flex-wrap items-center gap-x-2 font-mono">
                      <span className="break-all">{r.hostname}</span>
                      <span className="text-muted-foreground">{r.type}</span>
                      <span className="break-all">{r.value ?? "?"}</span>
                      {r.changed && <Badge variant="warning">{t.dnsChanged}</Badge>}
                    </li>
                  ))}
                </ul>
                <Link href={`/servers/${i.serverUuid}/domains`} className="inline-flex items-center gap-1 text-primary hover:underline">
                  {t.dnsLink} <ExternalLink className="size-3" />
                </Link>
              </div>
            )}
          </li>
        ))}
      </ul>
      {n("failed") > 0 && ev.status !== "running" && (
        <Alert variant="warning">
          <div>
            <AlertTitle>{t.failedTitle}</AlertTitle>
            <AlertDescription>{t.failedText}</AlertDescription>
          </div>
        </Alert>
      )}
      {cancel.error && <AdminError error={cancel.error} />}
    </div>
  );
}
