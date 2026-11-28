"use client";
import { CheckCircle2, CircleAlert, FileCode2, Play, PlugZap, RefreshCw, Square, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { ImportEgg, ImportServer, ImportSession, ImportUser } from "@panel/api";
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
import { formatBytes, formatDate, formatMb } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";
import { AdminError } from "./nodes";

const STATUS_VARIANT: Record<ImportServer["status"], BadgeVariant> = { pending: "secondary", creating: "info", copying: "info", done: "success", failed: "destructive", skipped: "outline" };
type Tab = "eggs" | "users" | "servers" | "plan";

/** Admin → Import: verbinden met Pterodactyl/Pelican, mapping, dry-run en import. */
export function ImporterAdmin() {
  const q = trpc.admin.importer.get.useQuery(undefined, { refetchInterval: (x) => (x.state.data?.state === "running" ? 2000 : false) });
  if (q.error) return <QueryError error={q.error} />;
  if (q.data === undefined) return <Skeleton className="h-64 rounded-xl" />;
  return q.data ? <ImportSessionView s={q.data} /> : <ConnectForm />;
}

function ConnectForm() {
  const t = useT().hostops.imp;
  const utils = trpc.useUtils();
  const [kind, setKind] = useState<"pterodactyl" | "pelican">("pterodactyl");
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clientKey, setClientKey] = useState("");
  const [sftpUser, setSftpUser] = useState("");
  const [sftpPass, setSftpPass] = useState("");
  const [sftpHost, setSftpHost] = useState("");
  const [sftpPort, setSftpPort] = useState("");
  const connect = trpc.admin.importer.connect.useMutation({ onSuccess: (d) => utils.admin.importer.get.setData(undefined, d) });
  const urlOk = /^https?:\/\/\S+$/.test(url.trim());
  return (
    <Card data-testid="import-connect">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PlugZap className="size-4" /> {t.connectTitle}
        </CardTitle>
        <CardDescription>{t.connectText}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!urlOk || apiKey.trim().length < 8) return;
            connect.mutate({
              kind,
              url: url.trim(),
              apiKey: apiKey.trim(),
              clientApiKey: clientKey.trim() || null,
              sftp: sftpUser.trim() && sftpPass ? { username: sftpUser.trim(), password: sftpPass, host: sftpHost.trim() || null, port: sftpPort ? Number(sftpPort) : null } : null,
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
            <div className="space-y-1.5">
              <Label htmlFor="imp-kind">{t.kind}</Label>
              <Select id="imp-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                <option value="pterodactyl">Pterodactyl</option>
                <option value="pelican">Pelican</option>
              </Select>
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="imp-url">{t.url}</Label>
              <Input id="imp-url" placeholder="https://panel.example.com" value={url} onChange={(e) => setUrl(e.target.value)} autoComplete="off" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imp-key">{t.appKey}</Label>
            <Input id="imp-key" type="password" placeholder={kind === "pelican" ? "peli_…" : "ptla_…"} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
            <p className="text-xs text-muted-foreground">{t.appKeyHint}</p>
          </div>
          <fieldset className="space-y-3 rounded-lg border border-border p-3">
            <legend className="px-1 text-sm font-medium">{t.filesTitle}</legend>
            <p className="text-xs text-muted-foreground">{t.filesText}</p>
            <div className="space-y-1.5">
              <Label htmlFor="imp-client">{t.clientKey}</Label>
              <Input id="imp-client" type="password" placeholder={kind === "pelican" ? "pacc_…" : "ptlc_…"} value={clientKey} onChange={(e) => setClientKey(e.target.value)} autoComplete="off" />
              <p className="text-xs text-muted-foreground">{t.clientKeyHint}</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="imp-sftp-user">{t.sftpUser}</Label>
                <Input id="imp-sftp-user" value={sftpUser} onChange={(e) => setSftpUser(e.target.value)} autoComplete="off" />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="imp-sftp-pass">{t.sftpPass}</Label>
                <Input id="imp-sftp-pass" type="password" value={sftpPass} onChange={(e) => setSftpPass(e.target.value)} autoComplete="off" />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="imp-sftp-host">{t.sftpHost}</Label>
                <Input id="imp-sftp-host" placeholder={t.sftpHostPlaceholder} value={sftpHost} onChange={(e) => setSftpHost(e.target.value)} autoComplete="off" />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="imp-sftp-port">{t.sftpPort}</Label>
                <Input id="imp-sftp-port" inputMode="numeric" placeholder="2022" value={sftpPort} onChange={(e) => setSftpPort(e.target.value.replace(/\D/g, ""))} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{t.sftpHint}</p>
          </fieldset>
          <Alert variant="info">
            <div>
              <AlertDescription>{t.readOnly}</AlertDescription>
            </div>
          </Alert>
          <Button type="submit" disabled={connect.isPending || !urlOk || apiKey.trim().length < 8} data-testid="import-connect-submit">
            {connect.isPending && <Spinner />} {t.connect}
          </Button>
          {connect.error && <AdminError error={connect.error} />}
        </form>
      </CardContent>
    </Card>
  );
}

function ImportSessionView({ s }: { s: ImportSession }) {
  const t = useT().hostops.imp;
  const utils = trpc.useUtils();
  const [tab, setTab] = useState<Tab>("eggs");
  const set = (d: ImportSession) => utils.admin.importer.get.setData(undefined, d);
  const refresh = trpc.admin.importer.refresh.useMutation({ onSuccess: set });
  const start = trpc.admin.importer.start.useMutation({ onSuccess: (d) => (set(d), void utils.admin.importer.dryRun.invalidate()) });
  const cancel = trpc.admin.importer.cancel.useMutation({ onSuccess: set });
  const disconnect = trpc.admin.importer.disconnect.useMutation({ onSuccess: () => utils.admin.importer.get.setData(undefined, null) });
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const running = s.state === "running";
  const count = (st: ImportServer["status"]) => s.servers.filter((x) => x.status === st).length;
  const err = refresh.error ?? start.error ?? cancel.error ?? disconnect.error;
  return (
    <div className="space-y-4" data-testid="import-session">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            {s.kind === "pelican" ? "Pelican" : "Pterodactyl"}
            <Badge variant={running ? "info" : s.state === "done" ? "success" : s.state === "cancelled" ? "outline" : "secondary"}>{t.state[s.state]}</Badge>
            {!s.connected && <Badge variant="outline">{t.disconnected}</Badge>}
          </CardTitle>
          <CardDescription className="break-all">
            <code className="font-mono">{s.url}</code> · {t.fetchedAt(formatDate(s.fetchedAt))}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            {[
              [t.countUsers, s.users.length],
              [t.countEggs, s.eggs.length],
              [t.countServers, s.servers.length],
              [t.countDone, `${count("done")} / ${s.servers.length}`],
            ].map(([k, v]) => (
              <div key={String(k)}>
                <dt className="text-xs text-muted-foreground">{k}</dt>
                <dd className="font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            {[s.hasClientKey ? t.withBackups : null, s.sftpUsername ? t.withSftp(s.sftpUsername) : null].filter(Boolean).join(" · ") || t.noFiles}
          </p>
          {s.warnings.length > 0 && (
            <Alert variant="warning">
              <CircleAlert />
              <div className="min-w-0">
                <AlertTitle>{t.warnings}</AlertTitle>
                <AlertDescription>
                  <ul className="list-disc space-y-0.5 pl-4">
                    {s.warnings.map((w) => (
                      <li key={w} className="break-words">
                        {w}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </div>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            {running ? (
              <Button variant="outline" onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <Square /> {t.stop}
              </Button>
            ) : (
              <Button onClick={() => start.mutate()} disabled={!s.connected || start.isPending || s.state === "done"} data-testid="import-start">
                {start.isPending ? <Spinner /> : <Play />} {count("failed") || s.state === "cancelled" ? t.resume : t.start}
              </Button>
            )}
            <Button variant="outline" onClick={() => refresh.mutate()} disabled={running || !s.connected || refresh.isPending}>
              {refresh.isPending ? <Spinner /> : <RefreshCw />} {t.refresh}
            </Button>
            {confirmDisconnect ? (
              <>
                <Button variant="destructive" onClick={() => disconnect.mutate()} disabled={running || disconnect.isPending}>
                  {disconnect.isPending && <Spinner />} {t.disconnectConfirm}
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>
                  {t.cancel}
                </Button>
              </>
            ) : (
              <Button variant="ghost" className="text-destructive" onClick={() => setConfirmDisconnect(true)} disabled={running}>
                <Trash2 /> {t.disconnect}
              </Button>
            )}
          </div>
          {confirmDisconnect && <p className="text-sm text-muted-foreground">{t.disconnectText}</p>}
          {s.state === "done" && (
            <p className="flex items-center gap-1.5 text-sm text-success" role="status">
              <CheckCircle2 className="size-4" /> {t.doneText}
            </p>
          )}
          {err && <AdminError error={err} />}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-muted/40 p-1" role="tablist">
        {(["eggs", "users", "servers", "plan"] as Tab[]).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={tab === k}
            className={cn("flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors", tab === k ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}
            onClick={() => setTab(k)}
          >
            {t.tabs[k]}
          </button>
        ))}
      </div>
      {tab === "eggs" && <EggsTab s={s} />}
      {tab === "users" && <UsersTab s={s} />}
      {tab === "servers" && <ServersTab s={s} />}
      {tab === "plan" && <PlanTab />}
    </div>
  );
}

function useSetMapping() {
  const utils = trpc.useUtils();
  return trpc.admin.importer.setMapping.useMutation({
    onSuccess: (d) => {
      utils.admin.importer.get.setData(undefined, d);
      void utils.admin.importer.dryRun.invalidate();
    },
  });
}

function EggsTab({ s }: { s: ImportSession }) {
  const t = useT().hostops.imp;
  const templates = trpc.admin.templates.list.useQuery();
  const save = useSetMapping();
  const [convert, setConvert] = useState<number | null>(null);
  const locked = s.state === "running";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.eggsTitle}</CardTitle>
        <CardDescription>{t.eggsText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="divide-y divide-border rounded-md border border-border text-sm">
          {s.eggs.map((e: ImportEgg) => (
            <li key={e.id} className="space-y-2 px-3 py-2" data-testid="import-egg">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate font-medium">{e.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[e.nestName, t.servers(e.serverCount), e.dockerImages[0]].filter(Boolean).join(" · ")}
                  </p>
                  {e.suggestion && (
                    <p className="text-xs text-muted-foreground">
                      {t.suggestion(e.suggestion.templateName, e.suggestion.score)} ({e.suggestion.reasons.map((r) => t.reasons[r as keyof typeof t.reasons] ?? r).join(", ")})
                    </p>
                  )}
                </div>
                <div className="w-full sm:w-60">
                  <label htmlFor={`egg-${e.id}`} className="sr-only">
                    {t.template}
                  </label>
                  <Select
                    id={`egg-${e.id}`}
                    disabled={locked || save.isPending}
                    value={e.action === "template" && e.templateId ? String(e.templateId) : ""}
                    onChange={(ev) => save.mutate({ eggs: [{ id: e.id, action: ev.target.value ? "template" : "skip", templateId: ev.target.value ? Number(ev.target.value) : null }] })}
                  >
                    <option value="">{t.skipEgg}</option>
                    {templates.data?.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name} ({x.type})
                      </option>
                    ))}
                  </Select>
                </div>
                <Button size="sm" variant="outline" onClick={() => setConvert(convert === e.id ? null : e.id)} disabled={locked}>
                  <FileCode2 /> {t.convert}
                </Button>
              </div>
              {convert === e.id && <EggConvert egg={e} onDone={() => setConvert(null)} />}
            </li>
          ))}
        </ul>
        {save.error && <AdminError error={save.error} />}
      </CardContent>
    </Card>
  );
}

function EggConvert({ egg, onDone }: { egg: ImportEgg; onDone: () => void }) {
  const t = useT().hostops.imp;
  const utils = trpc.useUtils();
  const conv = trpc.admin.importer.convertEgg.useQuery({ eggId: egg.id }, { staleTime: Number.POSITIVE_INFINITY });
  const [yaml, setYaml] = useState<string | null>(null);
  const save = useSetMapping();
  const validate = trpc.admin.templates.validate.useMutation();
  const create = trpc.admin.templates.create.useMutation({
    onSuccess: (tpl) => {
      void utils.admin.templates.list.invalidate();
      save.mutate({ eggs: [{ id: egg.id, action: "template", templateId: tpl.id }] }, { onSuccess: onDone });
    },
  });
  if (conv.error) return <QueryError error={conv.error} />;
  if (!conv.data) return <Skeleton className="h-40" />;
  const text = yaml ?? conv.data.yaml;
  const errors = validate.data && !validate.data.ok ? validate.data.errors : yaml === null ? conv.data.errors : [];
  return (
    <div className="space-y-2" data-testid="egg-convert">
      <p className="text-xs text-muted-foreground">{t.convertText}</p>
      <label htmlFor={`egg-yaml-${egg.id}`} className="sr-only">
        YAML
      </label>
      <textarea id={`egg-yaml-${egg.id}`} spellCheck={false} className="min-h-72 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs" value={text} onChange={(e) => (setYaml(e.target.value), validate.reset())} />
      {errors.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-xs text-destructive">
          {errors.map((x) => (
            <li key={x} className="break-words">
              {x}
            </li>
          ))}
        </ul>
      )}
      {validate.data?.ok && <p className="text-xs text-success">{t.valid}</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => validate.mutate({ yaml: text })} disabled={validate.isPending}>
          {validate.isPending && <Spinner />} {t.validate}
        </Button>
        <Button size="sm" onClick={() => create.mutate({ yaml: text })} disabled={create.isPending || save.isPending}>
          {(create.isPending || save.isPending) && <Spinner />} {t.saveTemplate}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t.cancel}
        </Button>
      </div>
      {(create.error || save.error) && <AdminError error={create.error ?? save.error} />}
    </div>
  );
}

function UsersTab({ s }: { s: ImportSession }) {
  const t = useT().hostops.imp;
  const accounts = trpc.admin.users.list.useQuery({ limit: 100 });
  const save = useSetMapping();
  const [ids, setIds] = useState<Record<number, string>>({});
  const locked = s.state === "running";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.usersTitle}</CardTitle>
        <CardDescription>{t.usersText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="divide-y divide-border rounded-md border border-border text-sm">
          {s.users.map((u: ImportUser) => {
            const did = ids[u.id] ?? u.discordId ?? u.sourceDiscordId ?? "";
            const didOk = /^\d{15,21}$/.test(did);
            return (
              <li key={u.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2" data-testid="import-user">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate font-medium">{u.username}</p>
                  <p className="truncate text-xs text-muted-foreground">{[u.email, t.servers(u.serverCount), u.matchedBy ? t.matched[u.matchedBy] : null].filter(Boolean).join(" · ")}</p>
                </div>
                <div className="w-full space-y-2 sm:w-64">
                  <label htmlFor={`user-act-${u.id}`} className="sr-only">
                    {t.userAction}
                  </label>
                  <Select
                    id={`user-act-${u.id}`}
                    disabled={locked || save.isPending}
                    value={u.action === "link" && u.accountId ? `link:${u.accountId}` : u.action}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v.startsWith("link:")) save.mutate({ users: [{ id: u.id, action: "link", accountId: Number(v.slice(5)), discordId: null }] });
                      else if (v === "create") {
                        if (didOk) save.mutate({ users: [{ id: u.id, action: "create", accountId: null, discordId: did }] });
                        else setIds((p) => ({ ...p, [u.id]: did }));
                      } else save.mutate({ users: [{ id: u.id, action: "skip", accountId: null, discordId: null }] });
                    }}
                  >
                    <option value="skip">{t.skipUser}</option>
                    <option value="create">{t.createUser}</option>
                    {accounts.data?.items.map((a) => (
                      <option key={a.id} value={`link:${a.id}`}>
                        {t.linkTo(a.name ?? a.discordId)}
                      </option>
                    ))}
                    {u.action === "link" && u.accountId && !accounts.data?.items.some((a) => a.id === u.accountId) && <option value={`link:${u.accountId}`}>{t.linkTo(u.accountName ?? String(u.accountId))}</option>}
                  </Select>
                  {(u.action === "create" || ids[u.id] !== undefined) && (
                    <form
                      className="flex gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (didOk) save.mutate({ users: [{ id: u.id, action: "create", accountId: null, discordId: did }] }, { onSuccess: () => setIds(({ [u.id]: _x, ...rest }) => rest) });
                      }}
                    >
                      <label htmlFor={`user-did-${u.id}`} className="sr-only">
                        {t.discordId}
                      </label>
                      <Input id={`user-did-${u.id}`} inputMode="numeric" placeholder={t.discordId} value={did} onChange={(e) => setIds((p) => ({ ...p, [u.id]: e.target.value.replace(/\D/g, "") }))} />
                      <Button type="submit" size="sm" variant="outline" disabled={!didOk || locked || save.isPending || did === u.discordId}>
                        {t.saveShort}
                      </Button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted-foreground">{t.usersHint}</p>
        {save.error && <AdminError error={save.error} />}
      </CardContent>
    </Card>
  );
}

function ServersTab({ s }: { s: ImportSession }) {
  const t = useT().hostops.imp;
  const nodes = trpc.admin.nodes.list.useQuery();
  const save = useSetMapping();
  const locked = s.state === "running";
  const eggName = new Map(s.eggs.map((e) => [e.id, e.name]));
  const userName = new Map(s.users.map((u) => [u.id, u.username]));
  const nodeOptions = (nodes.data ?? []).map((n) => (
    <option key={n.id} value={n.id} disabled={!!n.maintenance}>
      {n.name}
      {n.maintenance ? ` (${t.inMaintenance})` : ""}
    </option>
  ));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.serversTitle}</CardTitle>
        <CardDescription>{t.serversText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="max-w-xs space-y-1.5">
          <Label htmlFor="imp-default-node">{t.defaultNode}</Label>
          <Select id="imp-default-node" disabled={locked || save.isPending} value={s.defaultNodeId ?? ""} onChange={(e) => save.mutate({ defaultNodeId: e.target.value ? Number(e.target.value) : null })}>
            <option value="">–</option>
            {nodeOptions}
          </Select>
        </div>
        <ul className="divide-y divide-border rounded-md border border-border text-sm">
          {s.servers.map((x) => (
            <li key={x.id} className="space-y-1.5 px-3 py-2" data-testid="import-server" data-status={x.status}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <label className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                  <Checkbox
                    checked={x.include}
                    disabled={locked || save.isPending || x.status === "done"}
                    onChange={(e) => save.mutate({ servers: [{ id: x.id, include: e.target.checked, targetNodeId: x.targetNodeId, allocationIds: x.allocationIds }] })}
                    aria-label={x.name}
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{x.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[userName.get(x.ownerId), eggName.get(x.eggId), x.limits.ramMb ? formatMb(x.limits.ramMb) : t.unlimitedRam, x.allocations.map((a) => a.port).join(", ")].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </label>
                <div className="w-full sm:w-48">
                  <label htmlFor={`srv-node-${x.id}`} className="sr-only">
                    {t.targetNode}
                  </label>
                  <Select
                    id={`srv-node-${x.id}`}
                    disabled={locked || save.isPending || x.status === "done"}
                    value={x.targetNodeId ?? ""}
                    onChange={(e) => save.mutate({ servers: [{ id: x.id, include: x.include, targetNodeId: e.target.value ? Number(e.target.value) : null, allocationIds: null }] })}
                  >
                    <option value="">{t.useDefault}</option>
                    {nodeOptions}
                  </Select>
                </div>
                <Badge variant={STATUS_VARIANT[x.status]}>{t.status[x.status]}</Badge>
                {(x.status === "creating" || x.status === "copying") && <Spinner className="size-3" />}
              </div>
              {x.status === "copying" && x.bytes > 0 && <p className="text-xs text-muted-foreground">{t.copied(formatBytes(x.bytes), x.method ? t.method[x.method] : "")}</p>}
              {x.error && <p className="break-words text-xs text-destructive">{x.error}</p>}
              {x.newUuid && x.status === "done" && (
                <Link href={`/admin/servers/${x.newUuid}`} className="text-xs text-primary hover:underline">
                  {t.openServer}
                </Link>
              )}
            </li>
          ))}
        </ul>
        {save.error && <AdminError error={save.error} />}
      </CardContent>
    </Card>
  );
}

function PlanTab() {
  const t = useT().hostops.imp;
  const plan = trpc.admin.importer.dryRun.useQuery(undefined, { staleTime: 0 });
  return (
    <Card data-testid="import-plan">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          {t.planTitle}
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => void plan.refetch()} disabled={plan.isFetching}>
            {plan.isFetching ? <Spinner /> : <RefreshCw />} {t.planRefresh}
          </Button>
        </CardTitle>
        <CardDescription>{t.planText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {plan.error ? (
          <QueryError error={plan.error} />
        ) : !plan.data ? (
          <Skeleton className="h-32" />
        ) : (
          <>
            {plan.data.createUsers.length > 0 && (
              <div className="space-y-1">
                <p className="font-medium">{t.planUsers(plan.data.createUsers.length)}</p>
                <ul className="list-disc pl-5 text-muted-foreground">
                  {plan.data.createUsers.map((u) => (
                    <li key={u.discordId} className="break-all">
                      {u.username} – <code className="font-mono">{u.discordId}</code>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <ul className="space-y-2">
              {plan.data.servers.map((x) => (
                <li key={x.sourceId} className={cn("space-y-1 rounded-md border px-3 py-2", x.blocked ? "border-destructive/40" : "border-border")} data-testid="plan-server">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{x.name}</span>
                    {x.blocked ? <Badge variant="destructive">{t.planBlocked}</Badge> : <Badge variant="success">{t.method[x.method]}</Badge>}
                  </div>
                  {x.blocked ? (
                    <p className="break-words text-xs text-destructive">{x.blocked}</p>
                  ) : (
                    <p className="break-words text-xs text-muted-foreground">{t.planLine(x.owner ?? "–", x.template ?? "–", x.node ?? "–", x.ports.join(", ") || "–")}</p>
                  )}
                  {x.droppedVariables.length > 0 && <p className="break-words text-xs text-muted-foreground">{t.dropped(x.droppedVariables.join(", "))}</p>}
                  {x.warnings.map((w) => (
                    <p key={w} className="break-words text-xs text-warning">
                      {w}
                    </p>
                  ))}
                </li>
              ))}
            </ul>
            {plan.data.skipped.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {t.planSkipped}: {plan.data.skipped.map((x) => `${x.name} (${x.reason})`).join(", ")}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
