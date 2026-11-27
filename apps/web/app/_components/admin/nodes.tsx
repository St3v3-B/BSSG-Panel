"use client";
import { KeyRound, Plus, Server, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import type { Node } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorInfo, errorText } from "@/app/_lib/errors";
import { formatBytes, formatMb } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

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

const EMPTY = { name: "", fqdn: "", daemonPort: "8080", sftpPort: "2022", maxRamMb: "0", maxDiskMb: "0" };

export function NodesAdmin() {
  const t = useT();
  const n = t.admin.nodes;
  const utils = trpc.useUtils();
  const nodes = trpc.admin.nodes.list.useQuery();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [touched, setTouched] = useState(false);
  const create = trpc.admin.nodes.create.useMutation({
    onSuccess: () => {
      setForm(EMPTY);
      setOpen(false);
      setTouched(false);
      void utils.admin.nodes.list.invalidate();
    },
  });
  const invalid = !form.name.trim() || !form.fqdn.trim();
  const num = (v: string) => Math.max(0, Math.trunc(Number(v) || 0));

  return (
    <div className="space-y-6" data-testid="nodes-admin">
      {create.data && <TokenOnce title={n.tokenTitle} token={create.data.token} installCommand={create.data.installCommand} onDone={() => create.reset()} />}
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
                  fqdn: form.fqdn.trim(),
                  daemonPort: num(form.daemonPort),
                  sftpPort: num(form.sftpPort),
                  maxRamMb: num(form.maxRamMb),
                  maxDiskMb: num(form.maxDiskMb),
                });
              }}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                {(
                  [
                    ["name", n.name, "node2"],
                    ["fqdn", n.fqdn, "node2.example.com"],
                    ["daemonPort", n.daemonPort, ""],
                    ["sftpPort", n.sftpPort, ""],
                    ["maxRamMb", n.maxRam, ""],
                    ["maxDiskMb", n.maxDisk, ""],
                  ] as const
                ).map(([k, label, ph]) => (
                  <Field key={k} id={`node-${k}`} label={label}>
                    <Input
                      id={`node-${k}`}
                      value={form[k]}
                      placeholder={ph}
                      inputMode={k === "name" || k === "fqdn" ? undefined : "numeric"}
                      onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
                    />
                  </Field>
                ))}
              </div>
              {touched && invalid && <p className="text-xs text-destructive">{n.required}</p>}
              {create.error && <AdminError error={create.error} />}
              <div className="flex gap-2">
                <Button type="submit" disabled={create.isPending}>
                  {create.isPending && <Spinner />} {n.create}
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
            <NodeCard key={node.id} node={node} />
          ))}
        </div>
      )}
    </div>
  );
}

function NodeCard({ node }: { node: Node }) {
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
          </h1>
          <code className="font-mono text-sm text-muted-foreground">{d.fqdn}</code>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => regen.mutate({ id })} disabled={regen.isPending}>
            {regen.isPending ? <Spinner /> : <KeyRound />} {n.regenerate}
          </Button>
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
      {(regen.error || del.error) && <AdminError error={regen.error ?? del.error} />}
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
      <AllocationsAdmin nodeId={id} />
    </div>
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
            save.mutate({ id: node.id, name: node.name, fqdn: node.fqdn, daemonPort: node.daemonPort, sftpPort: node.sftpPort, maxRamMb: node.maxRamMb, maxDiskMb: node.maxDiskMb, s3TargetId: value ? Number(value) : null })
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
