"use client";
import { BellRing } from "lucide-react";
import { useState } from "react";
import type { AlarmConfig, ServerAlarms } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

/** Tekstvelden van een AlarmConfig ("" = drempel uit). */
export interface AlarmForm {
  enabled: boolean;
  cpu: string;
  ram: string;
  disk: string;
  duration: string;
}
export const toForm = (c: AlarmConfig): AlarmForm => ({ enabled: c.enabled, cpu: c.cpuPct?.toString() ?? "", ram: c.ramPct?.toString() ?? "", disk: c.diskPct?.toString() ?? "", duration: String(c.durationMinutes) });
const pct = (v: string): number | null | undefined => {
  if (!v.trim()) return null;
  if (!/^\d+$/.test(v.trim())) return undefined;
  const n = Number(v);
  return n >= 10 && n <= 100 ? n : undefined;
};
/** Formulier → config, of null als iets ongeldig is. */
export function fromForm(f: AlarmForm): AlarmConfig | null {
  const cpuPct = pct(f.cpu), ramPct = pct(f.ram), diskPct = pct(f.disk);
  const d = /^\d+$/.test(f.duration.trim()) ? Number(f.duration) : NaN;
  if (cpuPct === undefined || ramPct === undefined || diskPct === undefined || !(d >= 1 && d <= 120)) return null;
  return { enabled: f.enabled, cpuPct, ramPct, diskPct, durationMinutes: d };
}

/** Drempelvelden; gedeeld met de admin-standaard. */
export function AlarmFields({ form, set, idPrefix }: { form: AlarmForm; set: (f: AlarmForm) => void; idPrefix: string }) {
  const a = useT().alarms;
  const bad = (v: string) => pct(v) === undefined;
  const durBad = !(/^\d+$/.test(form.duration.trim()) && Number(form.duration) >= 1 && Number(form.duration) <= 120);
  const fields = [
    ["cpu", a.cpu],
    ["ram", a.ram],
    ["disk", a.disk],
  ] as const;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {fields.map(([k, label]) => (
          <div key={k} className="min-w-0 space-y-1">
            <Label htmlFor={`${idPrefix}-${k}`}>{label}</Label>
            <Input id={`${idPrefix}-${k}`} inputMode="numeric" placeholder={a.off} value={form[k]} disabled={!form.enabled} onChange={(e) => set({ ...form, [k]: e.target.value })} aria-invalid={bad(form[k]) || undefined} />
            {bad(form[k]) && <p className="text-xs text-destructive">{a.pctError}</p>}
          </div>
        ))}
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`${idPrefix}-duration`}>{a.duration}</Label>
          <Input id={`${idPrefix}-duration`} inputMode="numeric" value={form.duration} disabled={!form.enabled} onChange={(e) => set({ ...form, duration: e.target.value })} aria-invalid={durBad || undefined} />
          {durBad && <p className="text-xs text-destructive">{a.durationError}</p>}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{a.durationHint}</p>
    </div>
  );
}

export const summaryOf = (t: ReturnType<typeof useT>, c: AlarmConfig) => (c.enabled ? t.alarms.summary(c.cpuPct, c.ramPct, c.diskPct, c.durationMinutes) : t.alarms.defaultsOff);

/** Verbruiksalarmen van één server (eigenaar of admin). */
export function AlarmsCard({ uuid }: { uuid: string }) {
  const q = trpc.servers.alarms.useQuery({ uuid });
  if (q.error) return null;
  if (!q.data) return <Skeleton className="h-48 rounded-2xl" />;
  return <AlarmsForm key={uuid} uuid={uuid} data={q.data} />;
}

function AlarmsForm({ uuid, data }: { uuid: string; data: ServerAlarms }) {
  const t = useT();
  const a = t.alarms;
  const utils = trpc.useUtils();
  const [useDefaults, setUseDefaults] = useState(data.useDefaults);
  const [form, setForm] = useState<AlarmForm>(toForm(data.config));
  const [offline, setOffline] = useState(data.notifyOffline);
  const save = trpc.servers.updateAlarms.useMutation({ onSuccess: (r) => utils.servers.alarms.setData({ uuid }, r) });
  const config = useDefaults ? null : fromForm(form);
  const invalid = !useDefaults && !config;
  const { cooldownMinutes: _c, ...defaults } = data.defaults;
  return (
    <Card data-testid="alarms-card">
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
            if (!invalid) save.mutate({ uuid, config, notifyOffline: offline });
          }}
        >
          {data.active.length > 0 && (
            <div className="flex flex-wrap gap-2" data-testid="alarms-active">
              {data.active.map((x) => (
                <Badge key={x.metric} variant="warning" className="whitespace-normal">
                  {a.activeItem(a.metric[x.metric], x.valuePct, x.thresholdPct)} · {a.since(formatDate(x.since))}
                </Badge>
              ))}
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={useDefaults} onChange={(e) => (setUseDefaults(e.target.checked), save.reset(), !e.target.checked && setForm(toForm(defaults)))} className="mt-0.5" data-testid="alarms-defaults" />
            <span>
              {a.useDefaults}
              <span className="block text-xs text-muted-foreground">{a.defaultsInfo(summaryOf(t, defaults))}</span>
            </span>
          </label>
          {!useDefaults && (
            <div className="space-y-3 rounded-xl border border-border p-3">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox role="switch" checked={form.enabled} onChange={(e) => (setForm({ ...form, enabled: e.target.checked }), save.reset())} /> {a.enabled}
              </label>
              <AlarmFields form={form} set={(f) => (setForm(f), save.reset())} idPrefix="alarm" />
            </div>
          )}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={offline} onChange={(e) => (setOffline(e.target.checked), save.reset())} className="mt-0.5" data-testid="alarms-offline" />
            <span>
              {a.offline}
              <span className="block text-xs text-muted-foreground">{a.offlineHint}</span>
            </span>
          </label>
          <p className="text-xs text-muted-foreground">{a.hysteresis}</p>
          {save.error && <p className="text-sm text-destructive">{errorText(save.error)}</p>}
          {save.isSuccess && (
            <p className="text-sm text-success" role="status">
              {a.saved}
            </p>
          )}
          <Button type="submit" disabled={invalid || save.isPending}>
            {save.isPending && <Spinner />} {a.save}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
