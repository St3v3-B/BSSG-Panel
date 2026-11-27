"use client";
import { ArrowUpCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ImagePolicy, ImageUpdateInfo, ServerDetail } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { StatusBadge } from "@/app/_components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

/** Kleine badge op kaarten en in tabellen. */
export function ImageUpdateBadge({ info }: { info: ImageUpdateInfo }) {
  const t = useT().imageUpdates;
  if (!info.available) return null;
  return (
    <Badge variant={info.reinstallRequired ? "warning" : "info"} data-testid="image-update-badge" title={info.reinstallRequired ? t.reinstallNeeded : undefined}>
      <ArrowUpCircle aria-hidden /> {t.badge}
    </Badge>
  );
}

/** Melding bovenaan de serverpagina met "Update now" (eigenaar of admin). */
export function ImageUpdateNotice({ server, canManage }: { server: ServerDetail; canManage: boolean }) {
  const t = useT().imageUpdates;
  const utils = trpc.useUtils();
  const now = trpc.servers.updateImageNow.useMutation({ onSuccess: () => void utils.servers.get.invalidate({ uuid: server.uuid }) });
  const info = server.imageUpdate;
  if (!info.available) return null;
  return (
    <Alert className="border-info/40 bg-info/10" data-testid="image-update-notice">
      <ArrowUpCircle />
      <div className="flex-1">
        <AlertTitle>{t.badge}</AlertTitle>
        <AlertDescription>
          {info.reinstallRequired ? t.noticeReinstall : t.notice(server.type === "web")}
          {now.isSuccess && <span role="status"> {t.started}</span>}
          {now.error && <span className="text-destructive"> {errorText(now.error)}</span>}
        </AlertDescription>
      </div>
      {canManage && !info.reinstallRequired && (
        <Button size="sm" onClick={() => now.mutate({ uuid: server.uuid })} disabled={now.isPending || now.isSuccess}>
          {now.isPending ? <Spinner /> : <RefreshCw />} {t.updateNow}
        </Button>
      )}
    </Alert>
  );
}

const POLICIES: ImagePolicy[] = ["auto", "notify", "off"];

/** Beleid per server (servers.updateImagePolicy). Eigenaar of admin. */
export function ImageUpdateCard({ server }: { server: ServerDetail }) {
  const t = useT().imageUpdates;
  const utils = trpc.useUtils();
  const [value, setValue] = useState<string>(server.imageUpdate.policy ?? "default");
  const [saved, setSaved] = useState<string>(value);
  const save = trpc.servers.updateImagePolicy.useMutation({
    onSuccess: (_r, v) => (setSaved(v.policy ?? "default"), utils.servers.get.invalidate({ uuid: server.uuid })),
  });
  const now = trpc.servers.updateImageNow.useMutation({ onSuccess: () => void utils.servers.get.invalidate({ uuid: server.uuid }) });
  const info = server.imageUpdate;
  const changed = value !== saved;
  return (
    <Card data-testid="image-update-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ArrowUpCircle className="size-4 text-info" /> {t.title}
        </CardTitle>
        <CardDescription>{t.explain}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ uuid: server.uuid, policy: value === "default" ? null : (value as ImagePolicy) });
          }}
        >
          <div className="max-w-80 space-y-1.5">
            <Label htmlFor="image-policy">{t.policy}</Label>
            <Select id="image-policy" value={value} onChange={(e) => (setValue(e.target.value), save.reset())}>
              <option value="default">{t.policyDefault}</option>
              {POLICIES.map((p) => (
                <option key={p} value={p}>
                  {t.policies[p]}
                </option>
              ))}
            </Select>
          </div>
          <p className="text-sm text-muted-foreground" data-testid="image-update-status">
            {info.available ? (info.reinstallRequired ? t.statusReinstall : t.statusAvailable) : t.statusCurrent}
            {info.checkedAt && <> · {t.checkedAt(formatDate(info.checkedAt))}</>}
          </p>
          {save.error && <p className="text-sm text-destructive">{errorText(save.error)}</p>}
          {save.isSuccess && (
            <p className="text-sm text-success" role="status">
              {t.saved}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!changed || save.isPending}>
              {save.isPending && <Spinner />} {t.save}
            </Button>
            {info.available && !info.reinstallRequired && (
              <Button type="button" variant="secondary" onClick={() => now.mutate({ uuid: server.uuid })} disabled={now.isPending || now.isSuccess}>
                {now.isPending ? <Spinner /> : <RefreshCw />} {t.updateNow}
              </Button>
            )}
          </div>
          {now.isSuccess && (
            <p className="text-sm text-success" role="status">
              {t.started}
            </p>
          )}
          {now.error && <p className="text-sm text-destructive">{errorText(now.error)}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

/** /admin/settings/image-updates: standaardbeleid, onderhoudsvenster en overzicht van alle servers. */
export function ImageUpdatesAdmin() {
  const t = useT().imageUpdates;
  const utils = trpc.useUtils();
  const settings = trpc.admin.settings.get.useQuery();
  const list = trpc.admin.imageUpdates.list.useQuery();
  const [form, setForm] = useState<{ defaultPolicy: ImagePolicy; windowStart: string; windowEnd: string } | null>(null);
  const cur = form ?? (settings.data ? settings.data.imageUpdates : null);
  const save = trpc.admin.settings.update.useMutation({ onSuccess: () => utils.admin.settings.get.invalidate() });
  const check = trpc.admin.imageUpdates.checkNow.useMutation({ onSuccess: () => setTimeout(() => void utils.admin.imageUpdates.list.invalidate(), 5000) });
  const now = trpc.servers.updateImageNow.useMutation({ onSuccess: () => utils.admin.imageUpdates.list.invalidate() });
  if (settings.error) return <QueryError error={settings.error} />;
  if (!cur) return <Skeleton className="h-48 rounded-xl" />;
  const valid = CLOCK.test(cur.windowStart) && CLOCK.test(cur.windowEnd);
  const changed = !!form && (form.defaultPolicy !== settings.data!.imageUpdates.defaultPolicy || form.windowStart !== settings.data!.imageUpdates.windowStart || form.windowEnd !== settings.data!.imageUpdates.windowEnd);
  const edit = (patch: Partial<typeof cur>) => (save.reset(), setForm({ ...cur, ...patch }));
  const rows = list.data ?? [];
  const pending = rows.filter((r) => r.imageUpdate.available).length;
  return (
    <div className="space-y-6" data-testid="image-updates-admin">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.adminSettings}</CardTitle>
          <CardDescription>{t.adminExplain}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-4 sm:grid-cols-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) save.mutate({ imageUpdates: cur });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="iu-default">{t.defaultPolicy}</Label>
              <Select id="iu-default" value={cur.defaultPolicy} onChange={(e) => edit({ defaultPolicy: e.target.value as ImagePolicy })}>
                {POLICIES.map((p) => (
                  <option key={p} value={p}>
                    {t.policies[p]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="iu-start">{t.windowStart}</Label>
              <Input id="iu-start" type="time" value={cur.windowStart} onChange={(e) => edit({ windowStart: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="iu-end">{t.windowEnd}</Label>
              <Input id="iu-end" type="time" value={cur.windowEnd} onChange={(e) => edit({ windowEnd: e.target.value })} />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-3">{t.windowHint}</p>
            {save.error && <p className="text-sm text-destructive sm:col-span-3">{errorText(save.error)}</p>}
            {save.isSuccess && (
              <p className="text-sm text-success sm:col-span-3" role="status">
                {t.saved}
              </p>
            )}
            <div className="sm:col-span-3">
              <Button type="submit" disabled={!valid || !changed || save.isPending}>
                {save.isPending && <Spinner />} {t.save}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{t.overview}</CardTitle>
            <CardDescription>{t.pending(pending)}</CardDescription>
          </div>
          <Button variant="secondary" onClick={() => check.mutate()} disabled={check.isPending}>
            {check.isPending ? <Spinner /> : <RefreshCw />} {t.checkNow}
          </Button>
        </CardHeader>
        <CardContent>
          {check.isSuccess && (
            <p className="mb-3 text-sm text-success" role="status">
              {t.checkStarted}
            </p>
          )}
          {list.error ? (
            <QueryError error={list.error} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" data-testid="image-table">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3 font-medium">{t.colServer}</th>
                    <th className="py-2 pr-3 font-medium">{t.colImage}</th>
                    <th className="py-2 pr-3 font-medium">{t.colPolicy}</th>
                    <th className="py-2 pr-3 font-medium">{t.colStatus}</th>
                    <th className="py-2 pr-3 font-medium">{t.colChecked}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.uuid} className="border-t border-border" data-testid="image-row">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {r.templateName} · {r.nodeName} · <StatusBadge status={r.status} />
                        </div>
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs">{r.image}</td>
                      <td className="py-2 pr-3">
                        {t.policies[r.imageUpdate.effectivePolicy]}
                        {!r.imageUpdate.policy && <span className="text-xs text-muted-foreground"> ({t.byDefault})</span>}
                      </td>
                      <td className="py-2 pr-3">{r.imageUpdate.available ? <ImageUpdateBadge info={r.imageUpdate} /> : <span className="text-muted-foreground">{t.upToDate}</span>}</td>
                      <td className="py-2 pr-3 text-xs text-muted-foreground">{formatDate(r.imageUpdate.checkedAt)}</td>
                      <td className="py-2 text-right">
                        {r.imageUpdate.available && !r.imageUpdate.reinstallRequired && (
                          <Button size="sm" variant="secondary" disabled={now.isPending} onClick={() => now.mutate({ uuid: r.uuid })}>
                            {t.updateNow}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-muted-foreground">
                        {t.none}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
