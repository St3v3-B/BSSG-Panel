"use client";
import { useState } from "react";
import type { QuotaInput } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { AdminError } from "@/app/_components/admin/nodes";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { useT } from "@/app/_lib/i18n";

const DEFAULT: QuotaInput = { maxRamMb: 4096, maxDiskMb: 20000, maxCpuPct: 200, maxServers: 2, maxDatabases: 2, templateIds: null, nodeIds: null, maxPortsPerServer: 1 };

/** Admin: quotum van een gebruiker instellen of weghalen. */
export function QuotaEditor({ userId }: { userId: number }) {
  const q = trpc.admin.users.getQuota.useQuery({ id: userId });
  if (q.isPending) return <Skeleton className="h-40 rounded-xl" />;
  return <QuotaForm key={JSON.stringify(q.data)} userId={userId} current={q.data ?? null} />;
}

function QuotaForm({ userId, current }: { userId: number; current: QuotaInput | null }) {
  const t = useT().quota;
  const c = useT().common;
  const utils = trpc.useUtils();
  const templates = trpc.admin.templates.list.useQuery();
  const nodes = trpc.admin.nodes.list.useQuery();
  const [on, setOn] = useState(!!current);
  const [v, setV] = useState<QuotaInput>(current ?? DEFAULT);
  const done = () => Promise.all([utils.admin.users.getQuota.invalidate({ id: userId }), utils.admin.quotas.usage.invalidate(), utils.admin.activity.search.invalidate()]);
  const set = trpc.admin.users.setQuota.useMutation({ onSuccess: done });
  const clear = trpc.admin.users.clearQuota.useMutation({ onSuccess: done });
  const num = (k: "maxRamMb" | "maxDiskMb" | "maxCpuPct" | "maxServers" | "maxDatabases", label: string) => (
    <div className="space-y-1.5" key={k}>
      <Label htmlFor={`q-${k}`}>{label}</Label>
      <Input id={`q-${k}`} type="number" min={0} value={Number.isNaN(v[k]) ? "" : v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value === "" ? NaN : Number(e.target.value) })} />
    </div>
  );
  const pick = (key: "templateIds" | "nodeIds", all: string, list: Array<{ id: number; name: string }>) => {
    const sel = v[key];
    return (
      <fieldset className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={sel === null} onChange={(e) => setV({ ...v, [key]: e.target.checked ? null : [] })} aria-label={all} /> {all}
        </label>
        {sel !== null && (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {list.map((i) => (
              <label key={i.id} className="flex items-center gap-2 text-sm">
                <Checkbox checked={sel.includes(i.id)} onChange={(e) => setV({ ...v, [key]: e.target.checked ? [...sel, i.id] : sel.filter((y) => y !== i.id) })} aria-label={i.name} /> {i.name}
              </label>
            ))}
          </div>
        )}
      </fieldset>
    );
  };
  const valid = [v.maxRamMb, v.maxDiskMb, v.maxCpuPct, v.maxServers, v.maxDatabases].every((n) => Number.isInteger(n) && n >= 0) && (v.maxPortsPerServer === null || (v.maxPortsPerServer >= 1 && v.maxPortsPerServer <= 100));
  return (
    <Card data-testid="quota-editor">
      <CardHeader>
        <CardTitle className="text-base">{t.editor}</CardTitle>
        <CardDescription>{t.editorDescription}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <label className="flex items-center gap-2 text-sm font-medium">
          <Checkbox checked={on} onChange={(e) => setOn(e.target.checked)} aria-label={t.enabled} /> {t.enabled}
        </label>
        {on && (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              {num("maxRamMb", t.ram)}
              {num("maxDiskMb", t.disk)}
              {num("maxCpuPct", t.cpu)}
              {num("maxServers", t.servers)}
              {num("maxDatabases", t.databases)}
              <div className="space-y-1.5">
                <Label htmlFor="q-ports">{t.maxPorts}</Label>
                <Input id="q-ports" type="number" min={1} max={100} value={v.maxPortsPerServer ?? ""} onChange={(e) => setV({ ...v, maxPortsPerServer: e.target.value === "" ? null : Number(e.target.value) })} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t.template}</Label>
              {pick("templateIds", t.allTemplates, templates.data ?? [])}
            </div>
            <div className="space-y-1.5">
              <Label>{t.node}</Label>
              {pick("nodeIds", t.allNodes, nodes.data ?? [])}
            </div>
          </>
        )}
        {(set.error ?? clear.error) && <AdminError error={(set.error ?? clear.error)!} />}
        {(set.isSuccess || clear.isSuccess) && (
          <p className="text-sm text-success" role="status">
            {c.saved}
          </p>
        )}
        <div className="flex gap-2">
          {on ? (
            <Button disabled={!valid || set.isPending} onClick={() => set.mutate({ id: userId, ...v })}>
              {set.isPending && <Spinner />} {t.saveQuota}
            </Button>
          ) : (
            <Button variant="outline" disabled={!current || clear.isPending} onClick={() => clear.mutate({ id: userId })}>
              {clear.isPending && <Spinner />} {t.removeQuota}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
