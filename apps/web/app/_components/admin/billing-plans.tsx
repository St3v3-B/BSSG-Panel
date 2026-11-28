"use client";
import type { Plan, PlanInput } from "@panel/api";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { AdminError, Field } from "@/app/_components/admin/nodes";
import { mb, PriceText } from "@/app/_components/billing/common";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { formatCpuLimit } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

type Form = Omit<PlanInput, "priceCents"> & { price: string };

const empty = (): Form => ({
  name: "",
  description: "",
  type: "game",
  templateIds: [],
  nodeIds: null,
  ramMb: 2048,
  cpuPct: 100,
  diskMb: 10_240,
  maxDatabases: 1,
  maxBackups: 3,
  allocations: 1,
  price: "0.00",
  currency: "EUR",
  visible: true,
  sortOrder: 0,
});

const fromPlan = (p: Plan): Form => {
  const { id: _i, templates: _t, activeSubscriptions: _a, priceCents, ...rest } = p;
  return { ...rest, price: (priceCents / 100).toFixed(2) };
};

/** "12,50" of "12.50" → 1250; ongeldig → null. */
export function parsePrice(s: string): number | null {
  const m = /^\s*(\d{1,7})(?:[.,](\d{1,2}))?\s*$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

function PlanForm({ initial, id, onDone }: { initial: Form; id: number | null; onDone: () => void }) {
  const all = useT();
  const t = all.billing.admin;
  const utils = trpc.useUtils();
  const templates = trpc.admin.templates.list.useQuery();
  const nodes = trpc.admin.nodes.list.useQuery();
  const [f, setF] = useState<Form>(initial);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const done = async () => {
    await utils.admin.plans.list.invalidate();
    await utils.billing.plans.invalidate();
    onDone();
  };
  const create = trpc.admin.plans.create.useMutation({ onSuccess: done });
  const update = trpc.admin.plans.update.useMutation({ onSuccess: done });
  const price = parsePrice(f.price);
  const tpls = (templates.data ?? []).filter((x) => x.type === f.type);
  const valid = !!f.name.trim() && f.templateIds.length > 0 && price !== null;
  const num = (k: "ramMb" | "cpuPct" | "diskMb" | "maxDatabases" | "maxBackups" | "allocations" | "sortOrder", label: string) => (
    <Field id={`plan-${k}`} label={label}>
      <Input id={`plan-${k}`} type="number" value={Number.isNaN(f[k]) ? "" : f[k]} onChange={(e) => set(k, e.target.value === "" ? NaN : Number(e.target.value))} />
    </Field>
  );
  const pending = create.isPending || update.isPending;
  return (
    <Card data-testid="plan-form">
      <CardHeader>
        <CardTitle className="text-base">{id ? t.editPlan : t.newPlan}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            const { price: _p, ...rest } = f;
            const body: PlanInput = { ...rest, name: f.name.trim(), priceCents: price!, allocations: f.type === "web" ? 0 : f.allocations };
            if (id) update.mutate({ ...body, id });
            else create.mutate(body);
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="plan-name" label={t.name}>
              <Input id="plan-name" value={f.name} maxLength={100} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field id="plan-type" label={t.type}>
              <Select id="plan-type" value={f.type} onChange={(e) => setF((x) => ({ ...x, type: e.target.value as "game" | "web", templateIds: [], allocations: e.target.value === "web" ? 0 : Math.max(1, x.allocations) }))}>
                <option value="game">{all.billing.plans.game}</option>
                <option value="web">{all.billing.plans.web}</option>
              </Select>
            </Field>
          </div>
          <Field id="plan-description" label={t.description}>
            <textarea id="plan-description" className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" maxLength={2000} value={f.description} onChange={(e) => set("description", e.target.value)} />
          </Field>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t.templates}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {tpls.map((x) => (
                <label key={x.id} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={f.templateIds.includes(x.id)} onChange={(e) => set("templateIds", e.target.checked ? [...f.templateIds, x.id] : f.templateIds.filter((y) => y !== x.id))} /> {x.name}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-1.5">
            <legend className="text-sm font-medium">{t.nodes}</legend>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={f.nodeIds === null} onChange={(e) => set("nodeIds", e.target.checked ? null : [])} /> {t.nodesAuto}
            </label>
            {f.nodeIds !== null && (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {(nodes.data ?? []).map((n) => (
                  <label key={n.id} className="flex items-center gap-2 text-sm">
                    <Checkbox checked={f.nodeIds!.includes(n.id)} onChange={(e) => set("nodeIds", e.target.checked ? [...f.nodeIds!, n.id] : f.nodeIds!.filter((y) => y !== n.id))} /> {n.name}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
          <div className="grid gap-4 sm:grid-cols-3">
            {num("ramMb", t.ramMb)}
            {num("cpuPct", t.cpuPct)}
            {num("diskMb", t.diskMb)}
            {num("maxDatabases", t.maxDatabases)}
            {num("maxBackups", t.maxBackups)}
            {f.type === "game" && num("allocations", t.allocations)}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="plan-price" label={t.price}>
              <Input id="plan-price" inputMode="decimal" value={f.price} onChange={(e) => set("price", e.target.value)} aria-invalid={price === null} />
            </Field>
            <Field id="plan-currency" label={t.currency}>
              <Input id="plan-currency" value={f.currency} maxLength={3} onChange={(e) => set("currency", e.target.value.toUpperCase())} />
            </Field>
            {num("sortOrder", t.sortOrder)}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={f.visible} onChange={(e) => set("visible", e.target.checked)} /> {t.visible}
          </label>
          {(create.error ?? update.error) && <AdminError error={create.error ?? update.error} />}
          <div className="flex gap-2">
            <Button type="submit" disabled={!valid || pending}>
              {pending && <Spinner />} {all.common.save}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              {all.common.cancel}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Admin → Pakketten. */
export function PlansAdmin() {
  const all = useT();
  const t = all.billing.admin;
  const utils = trpc.useUtils();
  const settings = trpc.admin.billing.get.useQuery();
  const list = trpc.admin.plans.list.useQuery();
  const [editing, setEditing] = useState<{ id: number | null; form: Form } | null>(null);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const del = trpc.admin.plans.delete.useMutation({ onSuccess: () => (setConfirmDel(null), void utils.admin.plans.list.invalidate()) });

  return (
    <div className="space-y-4" data-testid="plans-admin">
      {settings.data && !settings.data.plansEnabled && (
        <Alert variant="info">
          <AlertDescription>{t.plansOff}</AlertDescription>
        </Alert>
      )}
      {editing ? (
        <PlanForm key={editing.id ?? "new"} id={editing.id} initial={editing.form} onDone={() => setEditing(null)} />
      ) : (
        <Button onClick={() => setEditing({ id: null, form: empty() })}>
          <Plus /> {t.newPlan}
        </Button>
      )}
      {del.error && <AdminError error={del.error} />}
      {list.error ? (
        <QueryError error={list.error} />
      ) : !list.data ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : list.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.noPlans}</p>
      ) : (
        <div className="grid gap-3">
          {list.data.map((p) => (
            <Card key={p.id} className="p-4" data-testid="admin-plan">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    {p.name}
                    <Badge variant="secondary">{p.type === "game" ? all.billing.plans.game : all.billing.plans.web}</Badge>
                    {!p.visible && <Badge variant="outline">{t.hidden}</Badge>}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    <PriceText cents={p.priceCents} currency={p.currency} /> · {mb(p.ramMb)} · {formatCpuLimit(p.cpuPct)} · {mb(p.diskMb)} · {p.templates.map((x) => x.name).join(", ")}
                  </div>
                  <div className="text-xs text-muted-foreground">{t.subscriptions(p.activeSubscriptions)}</div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing({ id: p.id, form: fromPlan(p) })} aria-label={`${t.edit} ${p.name}`}>
                    <Pencil /> {t.edit}
                  </Button>
                  {confirmDel === p.id ? (
                    <Button size="sm" variant="destructive" onClick={() => del.mutate({ id: p.id })} disabled={del.isPending}>
                      {t.deleteConfirm}
                    </Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDel(p.id)} aria-label={`${all.common.delete} ${p.name}`}>
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
