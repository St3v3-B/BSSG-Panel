"use client";
import { BellRing } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { AlarmDefaults } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { AlarmFields, fromForm, toForm, type AlarmForm } from "@/app/_components/server/alarms-card";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName } from "@/app/_components/user-avatar";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

/** Instellingen: standaard-alarmen en cooldown. */
export function AlarmDefaultsCard() {
  const q = trpc.admin.alarms.defaults.useQuery();
  if (q.error) return null;
  if (!q.data) return <Skeleton className="h-48 rounded-2xl" />;
  return <DefaultsForm data={q.data} />;
}

function DefaultsForm({ data }: { data: AlarmDefaults }) {
  const t = useT();
  const a = t.alarms.admin;
  const utils = trpc.useUtils();
  const [form, setForm] = useState<AlarmForm>(toForm(data));
  const [cooldown, setCooldown] = useState(String(data.cooldownMinutes));
  const save = trpc.admin.alarms.setDefaults.useMutation({ onSuccess: (r) => utils.admin.alarms.defaults.setData(undefined, r) });
  const c = fromForm(form);
  const cd = /^\d+$/.test(cooldown.trim()) ? Number(cooldown) : NaN;
  const cdBad = !(cd >= 5 && cd <= 1440);
  return (
    <Card data-testid="alarm-defaults">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BellRing className="size-4 text-primary" /> {a.title}
        </CardTitle>
        <CardDescription>{a.text}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (c && !cdBad) save.mutate({ ...c, cooldownMinutes: cd });
          }}
        >
          <label className="flex items-center gap-2 text-sm">
            <Checkbox role="switch" checked={form.enabled} onChange={(e) => (setForm({ ...form, enabled: e.target.checked }), save.reset())} /> {a.enabled}
          </label>
          <AlarmFields form={form} set={(f) => (setForm(f), save.reset())} idPrefix="alarm-default" />
          <div className="max-w-56 space-y-1">
            <Label htmlFor="alarm-cooldown">{a.cooldown}</Label>
            <Input id="alarm-cooldown" inputMode="numeric" value={cooldown} onChange={(e) => (setCooldown(e.target.value), save.reset())} aria-invalid={cdBad || undefined} />
            <p className={cdBad ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{cdBad ? a.cooldownError : a.cooldownHint}</p>
          </div>
          {save.error && <p className="text-sm text-destructive">{errorText(save.error)}</p>}
          {save.isSuccess && (
            <p className="text-sm text-success" role="status">
              {a.saved}
            </p>
          )}
          <Button type="submit" disabled={!c || cdBad || save.isPending}>
            {save.isPending && <Spinner />} {a.save}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Dashboard: servers met een actief verbruiksalarm. */
export function ActiveAlarms() {
  const t = useT();
  const a = t.alarms;
  const q = trpc.admin.alarms.active.useQuery(undefined, { refetchInterval: 60_000 });
  if (q.error) return null;
  return (
    <section className="space-y-3" data-testid="active-alarms">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">{a.admin.activeTitle}</h2>
      {!q.data ? (
        <Skeleton className="h-16 rounded-2xl" />
      ) : q.data.length === 0 ? (
        <Card className="p-4 text-sm text-muted-foreground">{a.admin.none}</Card>
      ) : (
        <Card className="divide-y divide-border">
          {q.data.map((x) => (
            <div key={`${x.server.uuid}-${x.metric}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-sm" data-testid="active-alarm">
              <BellRing className="size-4 shrink-0 text-warning" />
              <Link href={`/admin/servers/${x.server.uuid}`} className="min-w-0 max-w-full break-words font-medium hover:underline">
                {x.server.name}
              </Link>
              <Badge variant="warning" className="whitespace-normal">
                {a.activeItem(a.metric[x.metric], x.valuePct, x.thresholdPct)}
              </Badge>
              <span className="basis-full text-xs text-muted-foreground sm:ml-auto sm:basis-auto">
                {a.admin.owner(displayName(x.owner))} · {a.since(formatDate(x.since))}
              </span>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}
