"use client";
import { Check, KeyRound, Plus, Server, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { Node } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorInfo, errorText } from "@/app/_lib/errors";
import { formatBytes, formatMb } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { NodeHttpRelay } from "./node-relay";
import { NodeMaintenance } from "./node-maintenance";
import { NodeNpm } from "./node-npm";

/** Fouttekst; NOT_IMPLEMENTED (backend nog niet klaar) krijgt een eigen, rustige melding. */
export function AdminError({ error }: { error: unknown }) {
  const t = useT();
  const ni = errorInfo(error).code === "NOT_IMPLEMENTED" || errorInfo(error).message.startsWith("NOT_IMPLEMENTED");
  return (
    <Alert variant={ni ? "info" : "destructive"} data-testid={ni ? "not-implemented" : "admin-error"}>
      <div>
        <AlertDescription>{ni ? t.admin.notImplemented : errorText(error)}</AlertDescription>
      </div>
    </Alert>
  );
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** Token + installcommando, maar één keer zichtbaar. */
export function TokenOnce({ title, token, installCommand, onDone }: { title: string; token: string; installCommand: string; onDone: () => void }) {
  const t = useT();
  return (
    <Alert variant="warning" data-testid="node-token">
      <KeyRound />
      <div className="min-w-0 flex-1 space-y-3">
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{t.admin.nodes.tokenText}</AlertDescription>
        {[
          [t.admin.nodes.token, token],
          [t.admin.nodes.installCommand, installCommand],
        ].map(([label, value]) => (
          <div key={label} className="space-y-1 text-foreground">
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="flex items-start gap-1 rounded-md border border-border bg-background/60 px-3 py-2">
              <code className="flex-1 break-all font-mono text-xs">{value}</code>
              <CopyButton value={value!} label={t.common.copyX(label!)} />
            </div>
          </div>
        ))}
        <Button size="sm" variant="outline" onClick={onDone}>
          {t.admin.nodes.done}
        </Button>
      </div>
    </Alert>
  );
}

const EMPTY = { name: "", fqdn: "", supportsDomains: true, httpRelay: "", publicPort: "8443", allocationPorts: "25565-25600", daemonPort: "8080", sftpPort: "2022", maxRamMb: "0", maxDiskMb: "0" };

export function NodesAdmin() {
  const t = useT();
  const n = t.admin.nodes;
  const j = n.join;
  const utils = trpc.useUtils();
  const nodes = trpc.admin.nodes.list.useQuery();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [touched, setTouched] = useState(false);
  const create = trpc.admin.nodes.createJoin.useMutation({
    onSuccess: () => {
      setOpen(false);
      setTouched(false);
      void utils.admin.nodes.list.invalidate();
    },
  });
  const invalid = !form.name.trim() || (!!form.allocationPorts.trim() && !portsValid(form.allocationPorts));
  const num = (v: string) => Math.max(0, Math.trunc(Number(v) || 0));
  const relayCandidates = (nodes.data ?? []).filter((x) => x.supportsDomains && x.publicPort === 443 && x.httpRelayNodeId === null && x.httpMode !== "npm");
  const suggestion = `${form.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "node"}.<panel domain>`;

  return (
    <div className="space-y-6" data-testid="nodes-admin">
      {create.data && (
        <Card data-testid="node-join-created">
          <CardHeader>
            <CardTitle className="text-base">{create.data.node.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <JoinWizard nodeId={create.data.node.id} command={create.data.joinCommand} expiresAt={create.data.expiresAt} />
            <div className="flex gap-2">
              <Link href={`/admin/nodes/${create.data.node.id}`} className="text-sm underline">
                {create.data.node.name}
              </Link>
              <Button size="sm" variant="outline" onClick={() => create.reset()}>
                {n.done}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {open ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{n.add}</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                setTouched(true);
                if (invalid) return;
                create.mutate({
                  name: form.name.trim(),
                  fqdn: form.fqdn.trim() || undefined,
                  supportsDomains: form.supportsDomains,
                  publicPort: form.supportsDomains ? undefined : num(form.publicPort),
                  httpRelayNodeId: form.supportsDomains && form.httpRelay ? Number(form.httpRelay) : null,
                  allocationPorts: form.allocationPorts.replace(/\s+/g, ""),
                  daemonPort: num(form.daemonPort),
                  sftpPort: num(form.sftpPort),
                  maxRamMb: num(form.maxRamMb),
                  maxDiskMb: num(form.maxDiskMb),
                  s3TargetId: null,
                });
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="node-name" label={n.name}>
                  <Input id="node-name" value={form.name} placeholder="node2" onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </Field>
                <Field id="node-fqdn" label={j.domainOptional} hint={j.domainHint(suggestion)}>
                  <Input id="node-fqdn" value={form.fqdn} placeholder="node2.example.com" onChange={(e) => setForm((f) => ({ ...f, fqdn: e.target.value }))} />
                </Field>
              </div>
              <div className="space-y-1.5">
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox checked={form.supportsDomains} onChange={(e) => setForm((f) => ({ ...f, supportsDomains: e.target.checked }))} data-testid="node-supports-domains" />
                  {j.supportsDomains}
                </label>
                <p className="text-xs text-muted-foreground">{j.supportsHint}</p>
              </div>
              {form.supportsDomains && relayCandidates.length > 0 && (
                <Field id="node-httpRelay" label={n.relay.via} hint={n.relay.joinHint}>
                  <Select id="node-httpRelay" value={form.httpRelay} onChange={(e) => setForm((f) => ({ ...f, httpRelay: e.target.value }))} data-testid="node-http-relay-select">
                    <option value="">{n.relay.own}</option>
                    {relayCandidates.map((c) => (
                      <option key={c.id} value={String(c.id)}>
                        {n.relay.viaNode(c.name, c.fqdn)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              {!form.supportsDomains && (
                <Field id="node-publicPort" label={j.publicPort} hint={j.publicPortHint}>
                  <Input id="node-publicPort" className="w-40" inputMode="numeric" value={form.publicPort} onChange={(e) => setForm((f) => ({ ...f, publicPort: e.target.value }))} />
                </Field>
              )}
              <Field id="node-allocationPorts" label={j.allocationPorts}>
                <Input id="node-allocationPorts" value={form.allocationPorts} placeholder="25565-25600" onChange={(e) => setForm((f) => ({ ...f, allocationPorts: e.target.value }))} />
              </Field>
              <details className="rounded-md border border-border p-3">
                <summary className="cursor-pointer text-sm">{j.advanced}</summary>
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  {(
                    [
                      ["daemonPort", n.daemonPort],
                      ["sftpPort", n.sftpPort],
                      ["maxRamMb", n.maxRam],
                      ["maxDiskMb", n.maxDisk],
                    ] as const
                  ).map(([k, label]) => (
                    <Field key={k} id={`node-${k}`} label={label}>
                      <Input id={`node-${k}`} value={form[k]} inputMode="numeric" onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
                    </Field>
                  ))}
                </div>
              </details>
              {touched && invalid && <p className="text-xs text-destructive">{n.required}</p>}
              {create.error && <AdminError error={create.error} />}
              <div className="flex gap-2">
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending && <Spinner />} {j.submit}
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
          <Plus /> {n.add}
        </Button>
      )}

      {nodes.error ? (
        <QueryError error={nodes.error} />
      ) : !nodes.data ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : nodes.data.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">{n.empty}</Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {nodes.data.map((node) => (
            <NodeCard key={node.id} node={node} relayName={nodes.data.find((x) => x.id === node.httpRelayNodeId)?.name} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Live voortgang van een join: wachten op de node, Docker, DNS, daemon, certificaat, klaar. */
export function JoinWizard({ nodeId, command, expiresAt }: { nodeId: number; command?: string; expiresAt?: Date }) {
  const t = useT();
  const j = t.admin.nodes.join;
  const utils = trpc.useUtils();
  const [cmd, setCmd] = useState(command ? { command, expiresAt } : null);
  const status = trpc.admin.nodes.joinStatus.useQuery({ id: nodeId }, { refetchInterval: (q) => (q.state.data?.state === "ready" ? false : 3000) });
  const renew = trpc.admin.nodes.joinCommand.useMutation({
    onSuccess: (r) => {
      setCmd({ command: r.joinCommand, expiresAt: r.expiresAt });
      void utils.admin.nodes.joinStatus.invalidate({ id: nodeId });
    },
  });
  const st = status.data;
  const order = ["waiting", "docker", "download", "dns", "daemon", "certificate", "ready"] as const;
  const idx = st?.state ? order.indexOf(st.state === "failed" ? "waiting" : st.state) : 0;
  const steps: Array<{ key: keyof typeof j.steps; done: boolean; active: boolean }> = st
    ? [
        { key: "waiting", done: st.codeUsed, active: !st.codeUsed },
        { key: "docker", done: idx >= order.indexOf("download"), active: st.codeUsed && idx < order.indexOf("download") },
        { key: "dns", done: st.dns.ok, active: st.codeUsed && !st.dns.ok },
        { key: "daemon", done: st.daemonConnected, active: st.codeUsed && st.dns.ok && !st.daemonConnected },
        { key: "certificate", done: st.certificateOk, active: st.daemonConnected && !st.certificateOk },
        { key: "ready", done: st.state === "ready", active: false },
      ]
    : [];
  const expired = !!st && !st.codeUsed && !st.codeExpiresAt;
  return (
    <div className="space-y-4" data-testid="join-wizard">
      {st?.state !== "ready" && (
        <div className="space-y-2">
          <div className="text-sm font-medium">{j.commandTitle}</div>
          {cmd ? (
            <>
              <div className="flex items-start gap-1 rounded-md border border-border bg-muted/40 px-3 py-2">
                <code className="flex-1 break-all font-mono text-xs" data-testid="join-command">
                  {cmd.command}
                </code>
                <CopyButton value={cmd.command} label={t.common.copyX(j.commandTitle)} />
              </div>
              <p className="text-xs text-muted-foreground">
                {j.commandText} {cmd.expiresAt && j.expires(new Date(cmd.expiresAt).toLocaleTimeString())}
              </p>
            </>
          ) : (
            expired && <p className="text-sm text-muted-foreground">{j.expired}</p>
          )}
          {st && !st.codeUsed && (
            <Button size="sm" variant="outline" disabled={renew.isPending} onClick={() => renew.mutate({ id: nodeId })}>
              {renew.isPending && <Spinner />} {j.newCode}
            </Button>
          )}
          {st?.codeUsed && !st.daemonConnected && (
            <Button size="sm" variant="outline" disabled={renew.isPending} onClick={() => renew.mutate({ id: nodeId })}>
              {j.newCode}
            </Button>
          )}
        </div>
      )}
      {st && st.state !== "ready" && !st.dns.ok && (
        <div className="space-y-1 rounded-md border border-border p-3 text-sm" data-testid="join-dns">
          {st.dns.mode === "cloudflare" && st.codeUsed ? (
            <p>{j.dnsAuto}</p>
          ) : (
            <>
              <p>{j.dnsRecord}</p>
              <code className="block font-mono text-xs">
                {st.dns.record.name} A {st.dns.record.value ?? j.dnsIpUnknown}
              </code>
            </>
          )}
          {st.dns.resolvedIp && <p className="text-xs text-muted-foreground">{j.dnsResolved(st.dns.resolvedIp)}</p>}
        </div>
      )}
      {st && (
        <div>
          <div className="mb-2 text-sm font-medium">{j.stepsTitle}</div>
          <ol className="space-y-1.5 text-sm" data-testid="join-steps">
            {steps.map((x) => (
              <li key={x.key} className="flex items-center gap-2" data-done={x.done} data-active={x.active}>
                <span className="grid size-5 place-items-center">{x.done ? <Check className="size-4 text-success" /> : x.active ? <Spinner /> : <span className="size-2 rounded-full bg-muted-foreground/40" />}</span>
                <span className={x.done ? "" : "text-muted-foreground"}>{j.steps[x.key]}</span>
              </li>
            ))}
          </ol>
          {st.message && st.state !== "ready" && <p className={`mt-2 text-xs ${st.state === "failed" ? "text-destructive" : "text-muted-foreground"}`}>{st.state === "failed" ? `${j.failed}: ` : ""}{st.message}</p>}
          {st.state === "ready" && <p className="mt-2 text-sm text-success">{j.readyText(st.allocationsCreated)}</p>}
        </div>
      )}
      {status.error && <AdminError error={status.error} />}
      {renew.error && <AdminError error={renew.error} />}
    </div>
  );
}

function NodeCard({ node, relayName }: { node: Node; relayName?: string }) {
  const t = useT();
  const n = t.admin.nodes;
  return (
    <Card className="relative p-5 transition-colors hover:border-foreground/20" data-testid="node-card">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground">
            <Server className="size-5" />
          </span>
          <div className="min-w-0">
            <Link href={`/admin/nodes/${node.id}`} className="block truncate font-semibold after:absolute after:inset-0">
              {node.name}
            </Link>
            <code className="block truncate font-mono text-xs text-muted-foreground">{node.fqdn}</code>
          </div>
        </div>
        <div className="flex gap-1.5">
          {node.isLocal && <Badge variant="info">{n.local}</Badge>}
          {node.maintenance && <Badge variant="warning">{t.hostops.maint.badge}</Badge>}
          {!node.supportsDomains && <Badge variant="secondary">{n.join.noDomains}</Badge>}
          {node.httpMode === "npm" && <Badge variant="secondary" data-testid="node-npm-badge">{n.npm.badge}</Badge>}
          {node.httpRelayNodeId !== null && <Badge variant="secondary" data-testid="node-relay-badge">{n.relay.badge(relayName ?? String(node.httpRelayNodeId))}</Badge>}
          {node.diskQuotaMode ? <Badge variant="secondary">{node.diskQuotaMode}</Badge> : <Badge variant="warning">{n.neverConnected}</Badge>}
        </div>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {formatMb(node.maxRamMb)} · {formatMb(node.maxDiskMb)} · {n.daemonPort} {node.daemonPort} · {n.sftpPort} {node.sftpPort}
      </p>
    </Card>
  );
}

export function NodeDetail({ id, onDeleted }: { id: number; onDeleted: () => void }) {
  const t = useT();
  const n = t.admin.nodes;
  const utils = trpc.useUtils();
  const node = trpc.admin.nodes.get.useQuery({ id }, { retry: false });
  const regen = trpc.admin.nodes.regenerateToken.useMutation();
  const updateDaemon = trpc.admin.nodes.updateDaemon.useMutation();
  const [confirm, setConfirm] = useState(false);
  const del = trpc.admin.nodes.delete.useMutation({
    onSuccess: async () => {
      await utils.admin.nodes.list.invalidate();
      onDeleted();
    },
  });
  if (node.error) return <QueryError error={node.error} />;
  if (!node.data) return <Skeleton className="h-64 rounded-xl" />;
  const d = node.data;
  const h = d.health;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            {d.name}
            <Badge variant={h.online ? "success" : "destructive"}>{h.online ? n.online : n.offline}</Badge>
            {d.isLocal && <Badge variant="info">{n.local}</Badge>}
            {d.maintenance && <Badge variant="warning">{t.hostops.maint.badge}</Badge>}
          </h1>
          <code className="font-mono text-sm text-muted-foreground">{d.fqdn}</code>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => regen.mutate({ id })} disabled={regen.isPending}>
            {regen.isPending ? <Spinner /> : <KeyRound />} {n.regenerate}
          </Button>
          {!d.isLocal && (
            <Button variant="outline" onClick={() => updateDaemon.mutate({ id })} disabled={updateDaemon.isPending}>
              {updateDaemon.isPending && <Spinner />} {n.join.updateDaemon}
            </Button>
          )}
          {!d.isLocal &&
            (confirm ? (
              <>
                <Button variant="destructive" onClick={() => del.mutate({ id })} disabled={del.isPending}>
                  {del.isPending && <Spinner />} {n.deleteNode}
                </Button>
                <Button variant="ghost" onClick={() => setConfirm(false)}>
                  {t.common.cancel}
                </Button>
              </>
            ) : (
              <Button variant="outline" className="text-destructive" onClick={() => setConfirm(true)}>
                <Trash2 /> {n.deleteNode}
              </Button>
            ))}
        </div>
      </div>
      {regen.data && <TokenOnce title={n.regenerated} token={regen.data.token} installCommand={regen.data.installCommand} onDone={() => regen.reset()} />}
      {(regen.error || del.error || updateDaemon.error) && <AdminError error={regen.error ?? del.error ?? updateDaemon.error} />}
      {updateDaemon.isSuccess && <p className="text-sm text-success" role="status">{n.join.updateStarted}</p>}
      {confirm && !d.isLocal && <UninstallHint nodeId={id} serverCount={h.serverCount} />}
      {!d.isLocal && d.joinState && d.joinState !== "ready" && (
        <Card>
          <CardContent className="pt-6">
            <JoinWizard nodeId={id} />
          </CardContent>
        </Card>
      )}
      {!d.isLocal && d.httpRelayNodeId === null && <NodeDomainSupport node={d} />}
      {d.httpMode !== "npm" && <NodeHttpRelay node={d} />}
      <NodeNpm node={d} />
      <NodeMaintenance node={d} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{n.health}</CardTitle>
          {h.error && <CardDescription className="text-destructive">{h.error}</CardDescription>}
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted-foreground">{t.server.cpu}</dt>
              <dd>{h.cpuCount != null ? n.cpus(h.cpuCount) : "–"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{n.memory}</dt>
              <dd>
                {formatBytes(h.memoryUsedBytes)} / {formatBytes(h.memoryTotalBytes)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{n.disk}</dt>
              <dd>
                {formatBytes(h.diskFreeBytes)} / {formatBytes(h.diskTotalBytes)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t.admin.nav.servers}</dt>
              <dd>
                {n.servers(h.serverCount)}
                {h.version && <span className="text-xs text-muted-foreground"> · {n.version(h.version)}</span>}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <NodeBackupTarget node={d} />
      {!d.isLocal && (
        <Alert variant="info" data-testid="node-install-hint">
          <div>
            <AlertTitle>{n.nodeInstallTitle}</AlertTitle>
            <AlertDescription>{n.nodeInstallText}</AlertDescription>
          </div>
        </Alert>
      )}
      <NodeDatabase nodeId={id} />
      <NodeServers nodeId={id} />
      <AllocationsAdmin nodeId={id} />
    </div>
  );
}

function UninstallHint({ nodeId, serverCount }: { nodeId: number; serverCount: number }) {
  const t = useT();
  const j = t.admin.nodes.join;
  const q = trpc.admin.nodes.uninstallCommand.useQuery({ id: nodeId });
  return (
    <Alert variant="info" data-testid="node-uninstall">
      <div className="min-w-0 flex-1 space-y-2">
        <AlertTitle>{j.uninstallTitle}</AlertTitle>
        <AlertDescription>{serverCount > 0 ? j.removeHint : j.uninstallText}</AlertDescription>
        {q.data && (
          <div className="flex items-start gap-1 rounded-md border border-border bg-background/60 px-3 py-2 text-foreground">
            <code className="flex-1 break-all font-mono text-xs">{q.data.command}</code>
            <CopyButton value={q.data.command} label={t.common.copyX(j.uninstallTitle)} />
          </div>
        )}
      </div>
    </Alert>
  );
}

/** Domeinondersteuning (websites en domeinen voor gameservers) aan/uit; aan->uit alleen zonder websites/domeinen. */
function NodeDomainSupport({ node }: { node: Node }) {
  const t = useT();
  const j = t.admin.nodes.join;
  const utils = trpc.useUtils();
  const m = trpc.admin.nodes.update.useMutation({
    onSuccess: () => {
      void utils.admin.nodes.get.invalidate({ id: node.id });
      void utils.admin.nodes.list.invalidate();
    },
  });
  const toggle = () =>
    m.mutate({ id: node.id, name: node.name, fqdn: node.fqdn, daemonPort: node.daemonPort, sftpPort: node.sftpPort, maxRamMb: node.maxRamMb, maxDiskMb: node.maxDiskMb, s3TargetId: node.s3TargetId, supportsDomains: !node.supportsDomains, publicPort: node.supportsDomains ? 8443 : 443 });
  return (
    <Card data-testid="node-domain-support">
      <CardHeader>
        <CardTitle className="text-base">{j.domainsTitle}</CardTitle>
        <CardDescription>{node.supportsDomains ? j.domainsOn : `${j.domainsOff} ${node.publicPort}.`}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button variant="outline" onClick={toggle} disabled={m.isPending}>
          {m.isPending && <Spinner />} {node.supportsDomains ? j.domainsToggleOff : j.domainsToggleOn}
        </Button>
        {m.isSuccess && node.supportsDomains && <p className="text-xs text-muted-foreground">{j.domainsOnNote}</p>}
        {m.error && <AdminError error={m.error} />}
      </CardContent>
    </Card>
  );
}

/** Databasehost van de node (de node meldt zijn eigen MariaDB aan); de test loopt via de daemon. */
function NodeDatabase({ nodeId }: { nodeId: number }) {
  const t = useT();
  const n = t.admin.nodes;
  const hosts = trpc.admin.databaseHosts.list.useQuery();
  const test = trpc.admin.databaseHosts.test.useMutation();
  const host = hosts.data?.find((x) => x.nodeId === nodeId);
  return (
    <Card data-testid="node-database">
      <CardHeader>
        <CardTitle className="text-base">{n.dbTitle}</CardTitle>
        {hosts.data && !host && <CardDescription>{n.dbNone}</CardDescription>}
      </CardHeader>
      {host && (
        <CardContent className="flex flex-wrap items-center gap-3 text-sm">
          <code className="font-mono">{host.host}:{host.port}</code>
          <Badge variant="info">{host.daemonManaged ? n.dbManaged : n.dbExternal}</Badge>
          <span className="text-muted-foreground">{n.dbCount(host.databaseCount)}</span>
          <Button variant="outline" size="sm" onClick={() => test.mutate({ id: host.id })} disabled={test.isPending}>
            {test.isPending && <Spinner />} {n.dbTest}
          </Button>
          {test.data && <Badge variant={test.data.ok ? "success" : "destructive"}>{test.data.ok ? n.dbOk : n.dbDown}</Badge>}
          {test.data && !test.data.ok && test.data.error && <span className="text-xs text-destructive">{test.data.error}</span>}
        </CardContent>
      )}
    </Card>
  );
}

/** Standaard S3-doel voor backups van servers op deze node. */
function NodeBackupTarget({ node }: { node: Node }) {
  const t = useT();
  const n = t.admin.nodes;
  const utils = trpc.useUtils();
  const targets = trpc.admin.s3Targets.list.useQuery();
  const [value, setValue] = useState(node.s3TargetId ? String(node.s3TargetId) : "");
  const save = trpc.admin.nodes.update.useMutation({
    onSuccess: () => {
      void utils.admin.nodes.get.invalidate({ id: node.id });
      void utils.admin.nodes.list.invalidate();
    },
  });
  return (
    <Card data-testid="node-backup-target">
      <CardHeader>
        <CardTitle className="text-base">{n.s3Title}</CardTitle>
        <CardDescription>{n.s3Text}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-3">
        <div className="min-w-56 flex-1">
          <label htmlFor="node-s3" className="sr-only">
            {n.s3Title}
          </label>
          <Select id="node-s3" value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">{n.s3None}</option>
            {targets.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </div>
        <Button
          disabled={save.isPending}
          onClick={() =>
            save.mutate({ id: node.id, name: node.name, fqdn: node.fqdn, daemonPort: node.daemonPort, sftpPort: node.sftpPort, maxRamMb: node.maxRamMb, maxDiskMb: node.maxDiskMb, s3TargetId: value ? Number(value) : null, supportsDomains: node.supportsDomains, publicPort: node.publicPort })
          }
        >
          {save.isPending && <Spinner />} {n.s3Save}
        </Button>
        {save.isSuccess && <span className="text-sm text-success">{n.s3Saved}</span>}
        {save.error && <AdminError error={save.error} />}
      </CardContent>
    </Card>
  );
}

function NodeServers({ nodeId }: { nodeId: number }) {
  const t = useT();
  const q = trpc.admin.servers.list.useQuery({ nodeId, limit: 100 });
  return (
    <Card data-testid="node-servers">
      <CardHeader>
        <CardTitle className="text-base">{t.admin.nodes.nodeServers}</CardTitle>
      </CardHeader>
      <CardContent>
        {q.error ? (
          <QueryError error={q.error} />
        ) : !q.data ? (
          <Skeleton className="h-12" />
        ) : q.data.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.admin.nodes.nodeNoServers}</p>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {q.data.items.map((s) => (
              <li key={s.uuid} className="flex items-center justify-between gap-3 py-2">
                <Link href={`/admin/servers/${s.uuid}`} className="truncate font-medium hover:underline">
                  {s.name}
                </Link>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  <code className="font-mono">{s.shortId}</code>
                  <Badge variant="secondary">{s.status}</Badge>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
/** "25565" | "25565-25600" | "25565,25570-25575"; poorten 1–65535, bereik oplopend. */
export function portsValid(ports: string): boolean {
  const parts = ports.replace(/\s+/g, "").split(",");
  if (!parts.length || parts.some((p) => !p)) return false;
  return parts.every((p) => {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(p);
    if (!m) return false;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    return a >= 1 && b <= 65535 && a <= b;
  });
}

export function AllocationsAdmin({ nodeId }: { nodeId: number }) {
  const t = useT();
  const a = t.admin.allocations;
  const utils = trpc.useUtils();
  const list = trpc.admin.allocations.list.useQuery({ nodeId });
  const [ip, setIp] = useState("");
  const [ports, setPorts] = useState("");
  const [touched, setTouched] = useState(false);
  const create = trpc.admin.allocations.create.useMutation({
    onSuccess: () => {
      setPorts("");
      setTouched(false);
      void utils.admin.allocations.list.invalidate({ nodeId });
    },
  });
  const del = trpc.admin.allocations.delete.useMutation({ onSuccess: () => void utils.admin.allocations.list.invalidate({ nodeId }) });
  const ipErr = IPV4.test(ip.trim()) ? null : a.invalidIp;
  const portsErr = portsValid(ports) ? null : a.invalidPorts;
  const defaultIp = list.data?.[0]?.ip ?? "";

  return (
    <Card data-testid="allocations-admin">
      <CardHeader>
        <CardTitle className="text-base">{a.title}</CardTitle>
        <CardDescription>{a.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!ipErr && !portsErr) create.mutate({ nodeId, ip: ip.trim(), ports: ports.replace(/\s+/g, "") });
          }}
        >
          <div className="w-44 space-y-1">
            <Label htmlFor="alloc-ip" className="sr-only">
              {a.ip}
            </Label>
            <Input id="alloc-ip" placeholder={defaultIp || a.ip} value={ip} onFocus={() => !ip && defaultIp && setIp(defaultIp)} onChange={(e) => setIp(e.target.value)} />
            {touched && ipErr && <p className="text-xs text-destructive">{ipErr}</p>}
          </div>
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor="alloc-ports" className="sr-only">
              {a.ports}
            </Label>
            <Input id="alloc-ports" placeholder={a.portsHint} value={ports} onChange={(e) => setPorts(e.target.value)} />
            {touched && portsErr && <p className="text-xs text-destructive">{portsErr}</p>}
          </div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? <Spinner /> : <Plus />} {a.add}
          </Button>
        </form>
        {create.data && (
          <p className="text-sm text-success" role="status">
            {a.created(create.data.created)}
          </p>
        )}
        {(create.error || del.error) && <AdminError error={create.error ?? del.error} />}
        {list.error ? (
          <QueryError error={list.error} />
        ) : !list.data ? (
          <Skeleton className="h-24" />
        ) : list.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{a.empty}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {list.data.map((al) => (
              <div key={al.id} className="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm" data-testid="allocation">
                <code className="flex-1 font-mono">
                  {al.ip}:{al.port}
                </code>
                {al.serverUuid ? (
                  <Link href={`/servers/${al.serverUuid}`} className="text-xs text-muted-foreground hover:underline">
                    {al.primary ? a.primary : a.inUse}
                  </Link>
                ) : (
                  <>
                    <Badge variant="success">{a.free}</Badge>
                    <Button variant="ghost" size="icon-sm" className="size-7" aria-label={a.deleteX(`${al.ip}:${al.port}`)} onClick={() => del.mutate({ id: al.id })}>
                      <Trash2 />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
