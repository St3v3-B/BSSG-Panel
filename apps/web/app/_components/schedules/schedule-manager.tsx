"use client";
import { CalendarClock, Pencil, Play, Plus, Power, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Schedule } from "@panel/api";
import { ScheduleAction } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { CRON_PRESETS, previewCron } from "@/app/_lib/cron";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

type Action = (typeof ScheduleAction.options)[number];
interface Form {
  name: string;
  cron: string;
  action: Action;
  payload: string;
  active: boolean;
}
const EMPTY: Form = { name: "", cron: "0 4 * * *", action: "restart", payload: "", active: true };

export function ScheduleManager({ uuid, web = false }: { uuid: string; web?: boolean }) {
  const t = useT();
  const utils = trpc.useUtils();
  const list = trpc.schedules.list.useQuery({ uuid });
  const [editing, setEditing] = useState<null | "new" | number>(null);
  const done = () => (setEditing(null), void utils.schedules.list.invalidate({ uuid }));
  return (
    <div className="max-w-4xl space-y-6" data-testid="schedule-manager">
      {editing === null ? (
        <div>
          <Button onClick={() => setEditing("new")}>
            <Plus /> {t.schedules.add}
          </Button>
        </div>
      ) : (
        <ScheduleForm key={String(editing)} uuid={uuid} web={web} existing={typeof editing === "number" ? list.data?.find((s) => s.id === editing) : undefined} onDone={done} onCancel={() => setEditing(null)} />
      )}
      {list.error ? (
        <QueryError error={list.error} />
      ) : !list.data ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : list.data.length === 0 ? (
        <Card className="grid min-h-32 place-items-center p-6 text-sm text-muted-foreground">{t.schedules.empty}</Card>
      ) : (
        <div className="grid gap-3">
          {list.data.map((s) => (
            <ScheduleRow key={s.id} uuid={uuid} schedule={s} onEdit={() => setEditing(s.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScheduleForm({ uuid, web, existing, onDone, onCancel }: { uuid: string; web: boolean; existing?: Schedule; onDone: () => void; onCancel: () => void }) {
  const t = useT();
  const s = t.schedules;
  const [form, setForm] = useState<Form>(existing ? { name: existing.name, cron: existing.cron, action: existing.action, payload: existing.payload ?? "", active: existing.active } : EMPTY);
  const [touched, setTouched] = useState(false);
  const create = trpc.schedules.create.useMutation({ onSuccess: onDone });
  const update = trpc.schedules.update.useMutation({ onSuccess: onDone });
  const preview = previewCron(form.cron);
  const invalid = !form.name.trim() || !preview.ok || ((form.action === "command" || form.action === "exec") && !form.payload.trim());
  const pending = create.isPending || update.isPending;
  const submit = () => {
    setTouched(true);
    if (invalid) return;
    const input = { name: form.name.trim(), cron: form.cron.trim(), action: form.action, payload: form.action === "command" || form.action === "exec" ? form.payload.trim() : form.action === "backup" && form.payload ? form.payload : null, active: form.active };
    if (existing) update.mutate({ id: existing.id, ...input });
    else create.mutate({ uuid, ...input });
  };
  const err = create.error ?? update.error;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{existing ? s.editTitle : s.createTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="sch-name">{s.name}</Label>
            <Input id="sch-name" value={form.name} maxLength={100} placeholder={s.namePlaceholder} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-invalid={(touched && !form.name.trim()) || undefined} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sch-action">{s.action}</Label>
            <Select id="sch-action" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value as Action })}>
              {ScheduleAction.options.filter((a) => (web ? a !== "command" : a !== "exec")).map((a) => (
                <option key={a} value={a}>
                  {s.actions[a]}
                </option>
              ))}
            </Select>
          </div>
          {form.action === "backup" && (
            <div className="space-y-1">
              <Label htmlFor="sch-kind">{t.backupsInc.scheduleKind}</Label>
              <Select id="sch-kind" value={form.payload === "full" || form.payload === "incremental" ? form.payload : ""} onChange={(e) => setForm({ ...form, payload: e.target.value })}>
                <option value="">{t.backupsInc.scheduleKindDefault}</option>
                <option value="full">{t.backupsInc.kind.full}</option>
                <option value="incremental">{t.backupsInc.kind.incremental}</option>
              </Select>
            </div>
          )}
          {(form.action === "command" || form.action === "exec") && (
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="sch-payload">{form.action === "exec" ? s.execPayload : s.payload}</Label>
              {form.action === "exec" && <p className="text-xs text-muted-foreground">{s.execHint}</p>}
              <Input id="sch-payload" className="font-mono" value={form.payload} maxLength={1000} placeholder={form.action === "exec" ? s.execPlaceholder : s.payloadPlaceholder} onChange={(e) => setForm({ ...form, payload: e.target.value })} />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="sch-cron">{s.cron}</Label>
            <Input id="sch-cron" className="font-mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} aria-invalid={!preview.ok || undefined} aria-describedby="sch-cron-hint" />
            <p id="sch-cron-hint" className="text-xs text-muted-foreground">
              {s.cronHint}
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sch-preset">{s.preset}</Label>
            <Select id="sch-preset" value="" onChange={(e) => e.target.value && setForm({ ...form, cron: e.target.value })}>
              <option value="">{s.preset}</option>
              {CRON_PRESETS.map((p) => (
                <option key={p.key} value={p.cron}>
                  {s.presets[p.key]} ({p.cron})
                </option>
              ))}
            </Select>
          </div>
          <div className="sm:col-span-2" data-testid="cron-preview" aria-live="polite">
            {preview.ok ? (
              <div className="text-sm">
                <div className="text-xs text-muted-foreground">{s.nextRuns}</div>
                <ul className="mt-1 space-y-0.5">
                  {preview.next.map((d) => (
                    <li key={d.getTime()} className="font-mono text-xs">
                      {formatDate(d)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-destructive">{s.cronInvalid}</p>
            )}
          </div>
          <Label className="flex items-center gap-2 font-normal sm:col-span-2">
            <Checkbox checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> {s.active}
          </Label>
          {err && (
            <p className="text-sm text-destructive sm:col-span-2" role="alert">
              {errorText(err)}
            </p>
          )}
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" disabled={pending}>
              {pending && <Spinner />} {s.save}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t.common.cancel}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function ScheduleRow({ uuid, schedule: x, onEdit }: { uuid: string; schedule: Schedule; onEdit: () => void }) {
  const t = useT();
  const s = t.schedules;
  const utils = trpc.useUtils();
  const refresh = () => void utils.schedules.list.invalidate({ uuid });
  const [confirmDel, setConfirmDel] = useState(false);
  const toggle = trpc.schedules.update.useMutation({ onSuccess: refresh });
  const run = trpc.schedules.runNow.useMutation({ onSettled: refresh });
  const del = trpc.schedules.delete.useMutation({ onSuccess: refresh });
  const err = toggle.error ?? run.error ?? del.error;
  const result = x.lastResult == null ? null : x.lastResult === "ok" ? s.resultOk : s.resultError(x.lastResult.replace(/^error:\s*/, ""));
  return (
    <Card data-testid="schedule-row" className="p-4">
      <div className="flex flex-wrap items-center gap-3">
        <CalendarClock className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {x.name} <Badge variant="secondary">{s.actions[x.action]}</Badge>
            {!x.active && <Badge variant="outline">{s.inactive}</Badge>}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {x.cron}
            {(x.action === "command" || x.action === "exec") && x.payload && ` · ${x.payload}`}
            {x.action === "backup" && (x.payload === "full" || x.payload === "incremental") && ` · ${t.backupsInc.kind[x.payload]}`}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {s.lastRun}: {x.lastRunAt ? formatDate(x.lastRunAt) : s.never}
            {result && <span className={x.lastResult === "ok" ? "text-success" : "text-destructive"}> · {result}</span>}
            {x.active && x.nextRunAt && ` · ${s.nextRun}: ${formatDate(x.nextRunAt)}`}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate({ id: x.id })}>
            {run.isPending ? <Spinner /> : <Play />} {s.runNow}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={toggle.isPending}
            onClick={() => toggle.mutate({ id: x.id, name: x.name, cron: x.cron, action: x.action, payload: x.payload, active: !x.active })}
          >
            <Power /> {x.active ? s.disable : s.enable}
          </Button>
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil /> {s.edit}
          </Button>
          {confirmDel ? (
            <>
              <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate({ id: x.id })}>
                {s.delete}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDel(false)}>
                {t.common.cancel}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" className="text-destructive" aria-label={`${s.delete} ${x.name}`} onClick={() => setConfirmDel(true)}>
              <Trash2 />
            </Button>
          )}
        </div>
      </div>
      {x.action === "exec" && x.lastOutput && (
        <details className="mt-2" data-testid="schedule-output">
          <summary className="cursor-pointer text-xs text-muted-foreground">{s.output}</summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-muted p-2 font-mono text-xs whitespace-pre-wrap">{x.lastOutput}</pre>
        </details>
      )}
      {run.isSuccess && <p className="mt-2 text-sm text-success">{s.ranNow}</p>}
      {err && <p className="mt-2 text-sm text-destructive">{errorText(err)}</p>}
    </Card>
  );
}
