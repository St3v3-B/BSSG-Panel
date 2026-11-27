"use client";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { z } from "zod";
import type { DatabaseHost } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { AdminError, Field } from "@/app/_components/admin/nodes";
import { QueryError } from "@/app/_components/query-error";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { useT } from "@/app/_lib/i18n";
import { parseMcCodes } from "@/app/_lib/mc-motd";
import { cn } from "@/lib/utils";

const HEX = /^#[0-9a-fA-F]{6}$/;

export function SettingsAdmin() {
  const t = useT();
  const s = t.admin2.settings;
  const utils = trpc.useUtils();
  const q = trpc.admin.settings.get.useQuery();
  const [form, setForm] = useState<null | { panelName: string; logoUrl: string; accentColor: string; cpuPct: string; ramMb: string; swapMb: string; diskMb: string; promo: string; showLogoIcon: boolean; seedLogoIcon: boolean; retentionDays: string }>(null);
  useEffect(() => {
    if (q.data && !form) {
      const d = q.data;
      setForm({ panelName: d.panelName, logoUrl: d.logoUrl ?? "", accentColor: d.accentColor, cpuPct: String(d.defaultLimits.cpuPct), ramMb: String(d.defaultLimits.ramMb), swapMb: String(d.defaultLimits.swapMb), diskMb: String(d.defaultLimits.diskMb), promo: d.sleepMotd.promo, showLogoIcon: d.sleepMotd.showLogoIcon, seedLogoIcon: d.sleepMotd.seedLogoIcon, retentionDays: String(d.activityRetentionDays) });
    }
  }, [q.data, form]);
  const save = trpc.admin.settings.update.useMutation({
    onSuccess: () => {
      void utils.admin.settings.get.invalidate();
      void utils.auth.branding.invalidate();
    },
  });
  const [touched, setTouched] = useState(false);
  if (q.error) return <QueryError error={q.error} />;
  if (!form) return <Skeleton className="h-64 rounded-xl" />;
  const set = (k: "panelName" | "logoUrl" | "accentColor" | "cpuPct" | "ramMb" | "swapMb" | "diskMb" | "promo" | "retentionDays") => (e: React.ChangeEvent<HTMLInputElement>) => (save.reset(), setForm({ ...form, [k]: e.target.value }));
  const int = (v: string) => Math.trunc(Number(v));
  const limits = { cpuPct: int(form.cpuPct), ramMb: int(form.ramMb), swapMb: int(form.swapMb), diskMb: int(form.diskMb) };
  const invalid = !form.panelName.trim() || !HEX.test(form.accentColor) || Object.values(limits).some((v) => !Number.isFinite(v)) || limits.cpuPct < 0 || limits.ramMb < 64 || limits.swapMb < -1 || limits.diskMb < 0 || form.promo.length > 120 || !/^\d{1,4}$/.test(form.retentionDays.trim()) || int(form.retentionDays) > 3650;

  return (
    <form
      className="max-w-2xl space-y-6"
      data-testid="settings-form"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (invalid) return;
        save.mutate({ panelName: form.panelName.trim(), logoUrl: form.logoUrl.trim() || null, accentColor: form.accentColor, defaultLimits: limits, sleepMotd: { promo: form.promo.trim(), showLogoIcon: form.showLogoIcon, seedLogoIcon: form.seedLogoIcon }, activityRetentionDays: int(form.retentionDays) });
      }}
    >
      <Card>
        <CardContent className="space-y-4 pt-6">
          <Field id="set-name" label={s.panelName}>
            <Input id="set-name" value={form.panelName} maxLength={60} onChange={set("panelName")} />
          </Field>
          <Field id="set-logo" label={s.logoUrl} hint={s.logoHint}>
            <Input id="set-logo" value={form.logoUrl} onChange={set("logoUrl")} />
          </Field>
          <Field id="set-accent" label={s.accent}>
            <div className="flex items-center gap-2">
              <input type="color" aria-label={s.accent} value={HEX.test(form.accentColor) ? form.accentColor : "#22c55e"} onChange={set("accentColor")} className="h-9 w-12 cursor-pointer rounded-md border border-input bg-background p-1" />
              <Input id="set-accent" value={form.accentColor} onChange={set("accentColor")} className="w-32 font-mono" />
            </div>
          </Field>
          <div className="space-y-1.5" data-testid="accent-preview">
            <div className="text-sm font-medium">{s.preview}</div>
            <div className="flex items-center gap-3 rounded-lg border border-border p-3">
              {form.logoUrl.trim() && /^(https?:\/\/|\/)/.test(form.logoUrl.trim()) && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={form.logoUrl.trim()} alt="" className="size-8 rounded object-contain" />
              )}
              <span className="font-semibold" style={{ color: HEX.test(form.accentColor) ? form.accentColor : undefined }}>
                {form.panelName || "Panel"}
              </span>
              <span className="rounded-md px-3 py-1.5 text-sm font-medium text-white" style={{ backgroundColor: HEX.test(form.accentColor) ? form.accentColor : "#22c55e" }}>
                {s.previewButton}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{s.defaultLimits}</CardTitle>
          <CardDescription>{s.defaultLimitsHint}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field id="lim-cpu" label={s.cpu}>
            <Input id="lim-cpu" type="number" value={form.cpuPct} onChange={set("cpuPct")} />
          </Field>
          <Field id="lim-ram" label={s.ram}>
            <Input id="lim-ram" type="number" value={form.ramMb} onChange={set("ramMb")} />
          </Field>
          <Field id="lim-swap" label={s.swap}>
            <Input id="lim-swap" type="number" value={form.swapMb} onChange={set("swapMb")} />
          </Field>
          <Field id="lim-disk" label={s.disk}>
            <Input id="lim-disk" type="number" value={form.diskMb} onChange={set("diskMb")} />
          </Field>
        </CardContent>
      </Card>
      <Card data-testid="motd-card">
        <CardHeader>
          <CardTitle className="text-base">{s.motdTitle}</CardTitle>
          <CardDescription>{s.motdHint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id="set-promo" label={s.promo} hint={s.promoHint}>
            <Input id="set-promo" value={form.promo} maxLength={120} onChange={set("promo")} />
          </Field>
          <MotdPreview promo={form.promo} title={s.motdPreview} sleeping={s.motdSleeping} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.showLogoIcon} onChange={(e) => (save.reset(), setForm({ ...form, showLogoIcon: e.target.checked }))} />
            {s.showLogoIcon}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.seedLogoIcon} onChange={(e) => (save.reset(), setForm({ ...form, seedLogoIcon: e.target.checked }))} />
            {s.seedLogoIcon}
          </label>
        </CardContent>
      </Card>
      <Card data-testid="retention-card">
        <CardHeader>
          <CardTitle className="text-base">{s.retentionTitle}</CardTitle>
          <CardDescription>{s.retentionHint}</CardDescription>
        </CardHeader>
        <CardContent>
          <Field id="set-retention" label={s.activityRetention} hint={s.activityRetentionHint}>
            <Input id="set-retention" type="number" value={form.retentionDays} onChange={set("retentionDays")} className="w-32" />
          </Field>
        </CardContent>
      </Card>
      {touched && invalid && (
        <p className="text-sm text-destructive" role="alert">
          {s.invalid}
        </p>
      )}
      {save.error && <AdminError error={save.error} />}
      {save.isSuccess && (
        <p className="text-sm text-success" role="status">
          {s.saved}
        </p>
      )}
      <Button type="submit" disabled={save.isPending}>
        {save.isPending && <Spinner />} {s.save}
      </Button>
    </form>
  );
}

/** Voorbeeld van de serverlijst-regel van een slapende server, met Minecraft-kleuren. */
export function MotdPreview({ promo, title, sleeping }: { promo: string; title: string; sleeping: string }) {
  const spans = parseMcCodes(promo.trim() || "&e⚡ &fJoin to wake it up &8• &7Hosted on &b&lBSSG Panel");
  return (
    <div className="space-y-1.5" data-testid="motd-preview">
      <div className="text-sm font-medium">{title}</div>
      <div className="flex items-center gap-3 rounded-lg bg-[#1a1a1a] p-3 font-mono text-sm leading-snug">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/icon-192.png" alt="" className="size-16 shrink-0 [image-rendering:pixelated]" />
        <div className="min-w-0">
          <div>
            <span style={{ color: "#a99bff" }}>☾ </span>
            <span className="font-bold" style={{ color: "#a99bff" }}>Survival</span>
            <span style={{ color: "#aaaaaa" }}> {sleeping}</span>
          </div>
          <div data-testid="motd-line2">
            {spans.map((p, i) => (
              <span key={i} style={{ color: p.color, fontWeight: p.bold ? 700 : 400 }}>
                {p.text}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- database-hosts ----------

const EMPTY_HOST = { name: "", host: "", port: "3306", adminUser: "root", adminPassword: "", nodeId: "" };

export function DatabaseHostsAdmin() {
  const t = useT();
  const d = t.admin2.dbHosts;
  const utils = trpc.useUtils();
  const hosts = trpc.admin.databaseHosts.list.useQuery();
  const nodes = trpc.admin.nodes.list.useQuery();
  const [editing, setEditing] = useState<null | "new" | number>(null);
  const [form, setForm] = useState(EMPTY_HOST);
  const [touched, setTouched] = useState(false);
  const done = () => (setEditing(null), setForm(EMPTY_HOST), setTouched(false), void utils.admin.databaseHosts.list.invalidate());
  const create = trpc.admin.databaseHosts.create.useMutation({ onSuccess: done });
  const update = trpc.admin.databaseHosts.update.useMutation({ onSuccess: done });
  const del = trpc.admin.databaseHosts.delete.useMutation({ onSuccess: () => void utils.admin.databaseHosts.list.invalidate() });
  const test = trpc.admin.databaseHosts.test.useMutation();
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [tested, setTested] = useState<{ id: number; ok: boolean; error: string | null } | null>(null);

  const startEdit = (h: z.infer<typeof DatabaseHost>) => {
    create.reset();
    update.reset();
    setForm({ name: h.name, host: h.host, port: String(h.port), adminUser: h.adminUser, adminPassword: "", nodeId: h.nodeId ? String(h.nodeId) : "" });
    setEditing(h.id);
  };
  const isNew = editing === "new";
  const invalid = !form.name.trim() || !form.host.trim() || !form.adminUser.trim() || !Number.isInteger(Number(form.port)) || (isNew && !form.adminPassword);
  const submit = () => {
    setTouched(true);
    if (invalid) return;
    const base = { name: form.name.trim(), host: form.host.trim(), port: Number(form.port), adminUser: form.adminUser.trim(), nodeId: form.nodeId ? Number(form.nodeId) : null };
    if (isNew) create.mutate({ ...base, adminPassword: form.adminPassword });
    else if (typeof editing === "number") update.mutate({ id: editing, ...base, ...(form.adminPassword ? { adminPassword: form.adminPassword } : {}) });
  };
  const f = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });
  const err = create.error ?? update.error ?? del.error ?? test.error;

  return (
    <div className="space-y-4" data-testid="db-hosts-admin">
      {editing === null ? (
        <Button onClick={() => (create.reset(), setEditing("new"))}>
          <Plus /> {d.add}
        </Button>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{isNew ? d.add : d.edit}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <Field id="dbh-name" label={d.name}>
                <Input id="dbh-name" value={form.name} onChange={f("name")} />
              </Field>
              <Field id="dbh-host" label={d.host}>
                <Input id="dbh-host" value={form.host} onChange={f("host")} />
              </Field>
              <Field id="dbh-port" label={d.port}>
                <Input id="dbh-port" type="number" value={form.port} onChange={f("port")} />
              </Field>
              <Field id="dbh-user" label={d.adminUser}>
                <Input id="dbh-user" value={form.adminUser} onChange={f("adminUser")} />
              </Field>
              <Field id="dbh-pass" label={d.adminPassword} hint={isNew ? undefined : d.passwordKeep}>
                <Input id="dbh-pass" type="password" autoComplete="new-password" value={form.adminPassword} onChange={f("adminPassword")} />
              </Field>
              <Field id="dbh-node" label={d.node}>
                <Select id="dbh-node" value={form.nodeId} onChange={f("nodeId")}>
                  <option value="">{d.anyNode}</option>
                  {nodes.data?.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.name}
                    </option>
                  ))}
                </Select>
              </Field>
              {touched && invalid && (
                <p className="text-sm text-destructive sm:col-span-2" role="alert">
                  {t.admin.nodes.required}
                </p>
              )}
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={create.isPending || update.isPending}>
                  {(create.isPending || update.isPending) && <Spinner />} {d.save}
                </Button>
                <Button variant="ghost" onClick={() => (setEditing(null), setForm(EMPTY_HOST))}>
                  {t.common.cancel}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
      {err && <AdminError error={err} />}
      {hosts.error ? (
        <QueryError error={hosts.error} />
      ) : !hosts.data ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : hosts.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{d.empty}</p>
      ) : (
        <div className="grid gap-3">
          {hosts.data.map((h) => (
            <Card key={h.id} data-testid="db-host" className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{h.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {h.adminUser}@{h.host}:{h.port}
                  </div>
                </div>
                <Badge variant="secondary">{d.databases(h.databaseCount)}</Badge>
                <div className="ml-auto flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate({ id: h.id }, { onSuccess: (r) => setTested({ id: h.id, ...r }) })}>
                    {test.isPending && test.variables?.id === h.id && <Spinner />} {d.test}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => startEdit(h)}>
                    <Pencil /> {d.edit}
                  </Button>
                  {confirmDel === h.id ? (
                    <>
                      <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate({ id: h.id }, { onSuccess: () => setConfirmDel(null) })}>
                        {d.delete}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDel(null)}>
                        {t.common.cancel}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" className="text-destructive" aria-label={`${d.delete} ${h.name}`} onClick={() => setConfirmDel(h.id)}>
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
              {tested?.id === h.id && (
                <p className={cn("mt-2 text-sm", tested.ok ? "text-success" : "text-destructive")} role="status">
                  {tested.ok ? d.testOk : d.testFail(tested.error ?? "?")}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- DNS-providers ----------

export function DnsProvidersAdmin() {
  const t = useT();
  const d = t.admin2.dns;
  const utils = trpc.useUtils();
  const list = trpc.admin.dnsProviders.list.useQuery();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [touched, setTouched] = useState(false);
  const inv = () => void utils.admin.dnsProviders.list.invalidate();
  const create = trpc.admin.dnsProviders.create.useMutation({ onSuccess: () => (setOpen(false), setName(""), setToken(""), setTouched(false), inv()) });
  const refresh = trpc.admin.dnsProviders.refreshZones.useMutation({ onSuccess: inv });
  const del = trpc.admin.dnsProviders.delete.useMutation({ onSuccess: () => (setConfirmDel(null), inv()) });
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const invalid = !name.trim() || !token.trim();
  const err = create.error ?? refresh.error ?? del.error;

  return (
    <div className="space-y-4" data-testid="dns-admin">
      {open ? (
        <Card>
          <CardContent className="pt-6">
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                setTouched(true);
                if (!invalid) create.mutate({ type: "cloudflare", name: name.trim(), apiToken: token.trim() });
              }}
            >
              <Field id="dns-name" label={d.name}>
                <Input id="dns-name" value={name} onChange={(e) => setName(e.target.value)} />
              </Field>
              <Field id="dns-token" label={d.apiToken} hint={d.tokenHint}>
                <Input id="dns-token" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} />
              </Field>
              {touched && invalid && (
                <p className="text-sm text-destructive" role="alert">
                  {t.admin.nodes.required}
                </p>
              )}
              <div className="flex gap-2">
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending && <Spinner />} {d.save}
                </Button>
                <Button variant="ghost" onClick={() => (setOpen(false), create.reset())}>
                  {t.common.cancel}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Button onClick={() => setOpen(true)}>
          <Plus /> {d.add}
        </Button>
      )}
      {err && <AdminError error={err} />}
      {list.error ? (
        <QueryError error={list.error} />
      ) : !list.data ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : list.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{d.empty}</p>
      ) : (
        <div className="grid gap-3">
          {list.data.map((p) => (
            <Card key={p.id} className="p-4" data-testid="dns-provider">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{p.name}</div>
                  <div className="text-xs text-muted-foreground">Cloudflare</div>
                </div>
                <Badge variant="secondary">{d.zones(p.zones.length)}</Badge>
                <div className="ml-auto flex gap-2">
                  <Button size="sm" variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate({ id: p.id })}>
                    {refresh.isPending && refresh.variables?.id === p.id ? <Spinner /> : <RefreshCw />} {d.refresh}
                  </Button>
                  {confirmDel === p.id ? (
                    <>
                      <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate({ id: p.id })}>
                        {d.delete}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDel(null)}>
                        {t.common.cancel}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" className="text-destructive" aria-label={`${d.delete} ${p.name}`} onClick={() => setConfirmDel(p.id)}>
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
              {p.zones.length > 0 && <p className="mt-2 break-words text-xs text-muted-foreground">{p.zones.map((z) => z.name).join(", ")}</p>}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- backupopslag (S3) ----------

const EMPTY_S3 = { name: "", endpoint: "", bucket: "", region: "us-east-1", pathStyle: true, accessKey: "", secretKey: "" };

export function S3TargetsAdmin() {
  const t = useT();
  const d = t.admin2.s3;
  const utils = trpc.useUtils();
  const list = trpc.admin.s3Targets.list.useQuery();
  const [editing, setEditing] = useState<null | "new" | number>(null);
  const [form, setForm] = useState(EMPTY_S3);
  const [touched, setTouched] = useState(false);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);
  const [tested, setTested] = useState<{ id: number; ok: boolean; error: string | null } | null>(null);
  const inv = () => void utils.admin.s3Targets.list.invalidate();
  const done = () => (setEditing(null), setForm(EMPTY_S3), setTouched(false), inv());
  const create = trpc.admin.s3Targets.create.useMutation({ onSuccess: done });
  const update = trpc.admin.s3Targets.update.useMutation({ onSuccess: done });
  const del = trpc.admin.s3Targets.delete.useMutation({ onSuccess: () => (setConfirmDel(null), inv()) });
  const test = trpc.admin.s3Targets.test.useMutation();
  const isNew = editing === "new";
  const urlOk = /^https?:\/\/[^\s/]+/.test(form.endpoint.trim());
  const invalid = !form.name.trim() || !urlOk || !form.bucket.trim() || (isNew && (!form.accessKey || !form.secretKey));
  const submit = () => {
    setTouched(true);
    if (invalid) return;
    const base = { name: form.name.trim(), endpoint: form.endpoint.trim(), bucket: form.bucket.trim(), region: form.region.trim() || "us-east-1", pathStyle: form.pathStyle };
    if (isNew) create.mutate({ ...base, accessKey: form.accessKey, secretKey: form.secretKey });
    else if (typeof editing === "number") update.mutate({ id: editing, ...base, ...(form.accessKey ? { accessKey: form.accessKey } : {}), ...(form.secretKey ? { secretKey: form.secretKey } : {}) });
  };
  const f = (k: "name" | "endpoint" | "bucket" | "region" | "accessKey" | "secretKey") => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const err = create.error ?? update.error ?? del.error ?? test.error;
  return (
    <div className="space-y-4" data-testid="s3-admin">
      {editing === null ? (
        <Button onClick={() => (create.reset(), setEditing("new"))}>
          <Plus /> {d.add}
        </Button>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{isNew ? d.add : d.edit}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="grid gap-4 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                submit();
              }}
            >
              <Field id="s3-name" label={d.name}>
                <Input id="s3-name" value={form.name} onChange={f("name")} />
              </Field>
              <Field id="s3-endpoint" label={d.endpoint}>
                <Input id="s3-endpoint" placeholder="http://unraid.local:9000" value={form.endpoint} onChange={f("endpoint")} />
              </Field>
              <Field id="s3-bucket" label={d.bucket}>
                <Input id="s3-bucket" value={form.bucket} onChange={f("bucket")} />
              </Field>
              <Field id="s3-region" label={d.region}>
                <Input id="s3-region" value={form.region} onChange={f("region")} />
              </Field>
              <Field id="s3-access" label={d.accessKey} hint={isNew ? undefined : d.keysKeep}>
                <Input id="s3-access" autoComplete="off" value={form.accessKey} onChange={f("accessKey")} />
              </Field>
              <Field id="s3-secret" label={d.secretKey}>
                <Input id="s3-secret" type="password" autoComplete="new-password" value={form.secretKey} onChange={f("secretKey")} />
              </Field>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" className="size-4 accent-primary" checked={form.pathStyle} onChange={(e) => setForm({ ...form, pathStyle: e.target.checked })} /> {d.pathStyle}
              </label>
              {touched && invalid && (
                <p className="text-sm text-destructive sm:col-span-2" role="alert">
                  {t.admin.nodes.required}
                </p>
              )}
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={create.isPending || update.isPending}>
                  {(create.isPending || update.isPending) && <Spinner />} {d.save}
                </Button>
                <Button type="button" variant="ghost" onClick={() => (setEditing(null), setForm(EMPTY_S3))}>
                  {t.common.cancel}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
      {err && <AdminError error={err} />}
      {list.error ? (
        <QueryError error={list.error} />
      ) : !list.data ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : list.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{d.empty}</p>
      ) : (
        <div className="grid gap-3">
          {list.data.map((x) => (
            <Card key={x.id} data-testid="s3-target" className="p-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0">
                  <div className="font-medium">{x.name}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {x.endpoint} · {x.bucket} · {x.accessKeyPreview}…
                  </div>
                </div>
                <div className="ml-auto flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate({ id: x.id }, { onSuccess: (r) => setTested({ id: x.id, ...r }) })}>
                    {test.isPending && test.variables?.id === x.id && <Spinner />} {d.test}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => (update.reset(), setForm({ name: x.name, endpoint: x.endpoint, bucket: x.bucket, region: x.region, pathStyle: x.pathStyle, accessKey: "", secretKey: "" }), setEditing(x.id))}
                  >
                    <Pencil /> {d.edit}
                  </Button>
                  {confirmDel === x.id ? (
                    <>
                      <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate({ id: x.id })}>
                        {d.delete}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmDel(null)}>
                        {t.common.cancel}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" variant="outline" className="text-destructive" aria-label={`${d.delete} ${x.name}`} onClick={() => setConfirmDel(x.id)}>
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </div>
              {tested?.id === x.id && (
                <p className={cn("mt-2 text-sm", tested.ok ? "text-success" : "text-destructive")} role="status">
                  {tested.ok ? d.testOk : d.testFail(tested.error ?? "?")}
                </p>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
