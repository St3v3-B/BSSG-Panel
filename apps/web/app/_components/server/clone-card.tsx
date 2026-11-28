"use client";
import { AlertTriangle, CheckCircle2, Circle, Copy, Loader2, MinusCircle, X, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { CloneJob, CloneOptions, ServerDetail } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/app/_components/ui/dialog";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName } from "@/app/_components/user-avatar";
import { errorText } from "@/app/_lib/errors";
import { formatBytes, formatMb } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Kaart op de instellingenpagina: dialoog met formulier, daarna de voortgang. Eigenaar of admin. */
export function CloneCard({ server }: { server: ServerDetail }) {
  const t = useT();
  const c = t.clone;
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  return (
    <Card data-testid="clone-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Copy className="size-4 text-primary" /> {c.title}
        </CardTitle>
        <CardDescription>{c.text}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button variant="outline" onClick={() => (setJobId(null), setOpen(true))} data-testid="clone-open">
          <Copy /> {c.open}
        </Button>
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t.common.close} className="sm:max-w-xl" data-testid="clone-dialog">
          <DialogTitle className="pr-10 text-lg font-semibold">{c.dialogTitle(server.name)}</DialogTitle>
          <DialogDescription className="mb-4 text-sm text-muted-foreground">{c.text}</DialogDescription>
          {open && (jobId ? <CloneProgress id={jobId} /> : <CloneForm server={server} onStarted={setJobId} />)}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function CloneForm({ server, onStarted }: { server: ServerDetail; onStarted: (id: number) => void }) {
  const t = useT();
  const c = t.clone;
  const utils = trpc.useUtils();
  const opts = trpc.servers.cloneOptions.useQuery({ uuid: server.uuid }, { retry: false });
  const start = trpc.servers.clone.useMutation({
    onSuccess: (j) => {
      void utils.servers.list.invalidate();
      void utils.servers.clones.invalidate({ uuid: server.uuid });
      onStarted(j.id);
    },
  });
  if (opts.error) return <p className="text-sm text-destructive">{errorText(opts.error)}</p>;
  if (!opts.data)
    return (
      <div className="grid h-40 place-items-center">
        <Spinner />
      </div>
    );
  if (opts.data.running) return <CloneProgress id={opts.data.running.id} />;
  return <CloneFields key={server.uuid} server={server} o={opts.data} pending={start.isPending} error={start.error} onSubmit={(input) => start.mutate({ uuid: server.uuid, ...input })} />;
}

type CloneInput = { name: string; limits?: { cpuPct: number; ramMb: number; diskMb: number }; copyDatabases: boolean; domain: string | null; startAfter: boolean; ownerId?: number; nodeId?: number };

function CloneFields({ server, o, pending, error, onSubmit }: { server: ServerDetail; o: CloneOptions; pending: boolean; error: unknown; onSubmit: (i: CloneInput) => void }) {
  const t = useT();
  const c = t.clone;
  const [name, setName] = useState(c.defaultName(server.name).slice(0, 100));
  const [cpu, setCpu] = useState(String(o.limits.cpuPct));
  const [ram, setRam] = useState(String(o.limits.ramMb));
  const [disk, setDisk] = useState(String(o.limits.diskMb));
  const copyable = o.databases.filter((d) => d.copyable);
  const external = o.databases.filter((d) => !d.copyable);
  const [copyDb, setCopyDb] = useState(copyable.length > 0);
  const [domain, setDomain] = useState("");
  const [startAfter, setStartAfter] = useState(false);
  const [ownerId, setOwnerId] = useState<number | null>(null);
  const [nodeId, setNodeId] = useState<number | null>(null);
  const [ownerSearch, setOwnerSearch] = useState("");
  const users = trpc.admin.users.list.useQuery({ limit: 50, search: ownerSearch || undefined }, { enabled: o.isAdmin, placeholderData: (p) => p });
  const nodes = trpc.admin.nodes.list.useQuery(undefined, { enabled: o.isAdmin });
  const n = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : NaN);
  const limits = { cpuPct: n(cpu), ramMb: n(ram), diskMb: n(disk) };
  const limitsChanged = limits.cpuPct !== o.limits.cpuPct || limits.ramMb !== o.limits.ramMb || limits.diskMb !== o.limits.diskMb;
  const limitsBad = !(limits.cpuPct >= 1 && limits.cpuPct <= 6400 && limits.ramMb >= 64 && limits.diskMb >= 64);
  const domainBad = domain.trim() !== "" && !HOST.test(domain.trim());
  const nameBad = !name.trim() || name.trim().length > 100;
  const otherNode = o.isAdmin && nodeId !== null && nodeId !== server.node.id;
  const portsShort = o.type === "game" && !otherNode && o.freeAllocations < o.ports;
  const invalid = nameBad || limitsBad || domainBad || !o.allowed;

  if (!o.allowed)
    return (
      <Alert variant="warning" data-testid="clone-no-quota">
        <AlertTriangle />
        <AlertDescription>{c.noQuota}</AlertDescription>
      </Alert>
    );

  return (
    <form
      className="space-y-4"
      data-testid="clone-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        onSubmit({
          name: name.trim(),
          ...(limitsChanged ? { limits } : {}),
          copyDatabases: copyDb && copyable.length > 0,
          domain: o.type === "web" && domain.trim() ? domain.trim().toLowerCase() : null,
          startAfter,
          ...(o.isAdmin && ownerId !== null ? { ownerId } : {}),
          ...(o.isAdmin && nodeId !== null && nodeId !== server.node.id ? { nodeId } : {}),
        });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="clone-name">{c.name}</Label>
        <Input id="clone-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-invalid={nameBad || undefined} />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{c.limits}</legend>
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["clone-cpu", c.cpu, cpu, setCpu],
              ["clone-ram", c.ram, ram, setRam],
              ["clone-disk", c.disk, disk, setDisk],
            ] as const
          ).map(([id, label, v, set]) => (
            <div key={id} className="min-w-0 space-y-1">
              <Label htmlFor={id} className="text-xs text-muted-foreground">
                {label}
              </Label>
              <Input id={id} inputMode="numeric" value={v} onChange={(e) => set(e.target.value)} aria-invalid={limitsBad || undefined} />
            </div>
          ))}
        </div>
        {o.quota && <p className="text-xs text-muted-foreground" data-testid="clone-quota">{c.quotaLeft(formatMb(Math.max(0, o.quota.ramMb)), formatMb(Math.max(0, o.quota.diskMb)), Math.max(0, o.quota.cpuPct), Math.max(0, o.quota.servers))}</p>}
        {o.type === "game" && <p className="text-xs text-muted-foreground">{c.ports(o.ports)}</p>}
        {portsShort && <p className="text-xs text-destructive">{c.noFreePorts(o.ports, o.freeAllocations)}</p>}
      </fieldset>

      {o.isAdmin && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="clone-owner">{c.owner}</Label>
            <Input placeholder={c.ownerSearch} aria-label={c.ownerSearch} value={ownerSearch} onChange={(e) => setOwnerSearch(e.target.value)} className="mb-1.5" />
            <Select id="clone-owner" value={ownerId ?? ""} onChange={(e) => setOwnerId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">
                {c.sameOwner} ({displayName(server.owner)})
              </option>
              {(users.data?.items ?? [])
                .filter((u) => u.id !== server.owner.id)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {displayName(u)}
                  </option>
                ))}
            </Select>
          </div>
          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="clone-node">{c.node}</Label>
            <Select id="clone-node" value={nodeId ?? server.node.id} onChange={(e) => setNodeId(Number(e.target.value))}>
              {(nodes.data ?? [{ id: server.node.id, name: server.node.name }]).map((nd) => (
                <option key={nd.id} value={nd.id}>
                  {nd.id === server.node.id ? `${nd.name} · ${c.sameNode}` : nd.name}
                </option>
              ))}
            </Select>
            {otherNode && <p className="text-xs text-muted-foreground">{c.otherNodeHint}</p>}
          </div>
        </div>
      )}

      {o.databases.length > 0 && (
        <div className="space-y-2 rounded-xl border border-border p-3">
          {copyable.length > 0 && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={copyDb} onChange={(e) => setCopyDb(e.target.checked)} data-testid="clone-copy-db" className="mt-0.5" />
              <span className="min-w-0">
                {c.copyDatabases} <span className="break-all text-muted-foreground">({copyable.map((d) => d.name).join(", ")})</span>
                <span className="block text-xs text-muted-foreground">{c.copyDatabasesHint}</span>
              </span>
            </label>
          )}
          {external.length > 0 && <p className="break-all text-xs text-muted-foreground">{c.externalDb(external.map((d) => d.name).join(", "))}</p>}
          {copyDb && copyable.length > 0 && <DbConfigWarning />}
        </div>
      )}

      {o.type === "web" && (
        <div className="space-y-1.5">
          <Label htmlFor="clone-domain">{c.domain}</Label>
          <Input id="clone-domain" value={domain} placeholder="staging.example.com" onChange={(e) => setDomain(e.target.value)} aria-invalid={domainBad || undefined} autoCapitalize="none" spellCheck={false} />
          <p className="text-xs text-muted-foreground">{c.domainHint}</p>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={startAfter} onChange={(e) => setStartAfter(e.target.checked)} /> {c.startAfter}
      </label>

      {o.notes.filter((x) => x !== "external_databases").length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground" data-testid="clone-notes">
          {o.notes
            .filter((x) => x !== "external_databases")
            .map((x) => (
              <li key={x} className="flex gap-1.5">
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
                <span>{c.notes[x]}</span>
              </li>
            ))}
        </ul>
      )}

      {error ? <p className="text-sm text-destructive">{errorText(error)}</p> : null}
      <Button type="submit" disabled={invalid || pending} className="w-full sm:w-auto" data-testid="clone-submit">
        {pending ? <Spinner /> : <Copy />} {pending ? c.starting : c.start}
      </Button>
    </form>
  );
}

function DbConfigWarning() {
  const c = useT().clone;
  return (
    <Alert variant="warning" data-testid="clone-db-warning">
      <AlertTriangle />
      <div>
        <AlertTitle>{c.dbConfigWarningTitle}</AlertTitle>
        <AlertDescription>{c.dbConfigWarning}</AlertDescription>
      </div>
    </Alert>
  );
}

const StepIcon = ({ s }: { s: CloneJob["steps"][number]["status"] }) =>
  s === "done" ? <CheckCircle2 className="size-4 text-success" /> : s === "running" ? <Loader2 className="size-4 animate-spin text-primary" /> : s === "failed" ? <XCircle className="size-4 text-destructive" /> : s === "skipped" ? <MinusCircle className="size-4 text-muted-foreground/60" /> : <Circle className="size-4 text-muted-foreground" />;

/** Voortgang van één kopieeropdracht (pollt zolang hij loopt), met annuleren. */
export function CloneProgress({ id }: { id: number }) {
  const t = useT();
  const c = t.clone;
  const utils = trpc.useUtils();
  const q = trpc.servers.cloneJob.useQuery({ id }, { refetchInterval: (query) => (query.state.data?.status === "running" ? 1500 : false) });
  const cancel = trpc.servers.cancelClone.useMutation({ onSuccess: () => utils.servers.cloneJob.invalidate({ id }) });
  const j = q.data;
  if (q.error) return <p className="text-sm text-destructive">{errorText(q.error)}</p>;
  if (!j)
    return (
      <div className="grid h-40 place-items-center">
        <Spinner />
      </div>
    );
  const files = j.steps.find((s) => s.key === "files");
  const pct = j.bytesTotal ? Math.min(100, Math.round((j.bytesCopied / j.bytesTotal) * 100)) : null;
  return (
    <div className="space-y-4" data-testid="clone-progress" data-status={j.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 text-sm font-medium">
          <span className="break-words">{c.copyTo(j.target.name)}</span>
        </div>
        <Badge variant={j.status === "succeeded" ? "success" : j.status === "running" ? "secondary" : "destructive"}>{c.status[j.status]}</Badge>
      </div>
      <ol className="space-y-2">
        {j.steps
          .filter((s) => s.status !== "skipped" || s.key === "files")
          .map((s) => (
            <li key={s.key} className="flex items-start gap-2 text-sm" data-testid={`clone-step-${s.key}`} data-status={s.status}>
              <span className="mt-0.5">
                <StepIcon s={s.status} />
              </span>
              <div className="min-w-0 flex-1">
                <div>{c.steps[s.key]}</div>
                {s.key === "files" && s.status === "running" && (
                  <div className="mt-1 space-y-1">
                    {j.sameNode && j.bytesCopied === 0 ? (
                      <p className="text-xs text-muted-foreground">{c.sameNodeCopy}</p>
                    ) : (
                      <>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/80" role="progressbar" aria-label={c.steps.files} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
                          <div className="brand-gradient h-full rounded-full transition-[width] duration-500" style={{ width: `${pct ?? 5}%` }} />
                        </div>
                        <p className="text-xs tabular-nums text-muted-foreground">{c.bytes(formatBytes(j.bytesCopied), j.bytesTotal ? formatBytes(j.bytesTotal) : null)}</p>
                      </>
                    )}
                  </div>
                )}
                {s.key === "files" && s.status === "done" && j.bytesCopied > 0 && <p className="text-xs tabular-nums text-muted-foreground">{formatBytes(j.bytesCopied)}</p>}
              </div>
            </li>
          ))}
      </ol>
      {files && j.live && j.status === "running" && <p className="text-xs text-muted-foreground">{c.notes.live_copy}</p>}

      {j.status === "succeeded" && <p className="text-sm text-success" role="status">{c.succeeded}</p>}
      {j.status === "failed" && (
        <Alert variant="destructive">
          <XCircle />
          <div className="min-w-0">
            <AlertTitle>{c.failed}</AlertTitle>
            {j.error && <AlertDescription className="break-words">{j.error}</AlertDescription>}
          </div>
        </Alert>
      )}
      {j.status === "canceled" && <p className="text-sm text-muted-foreground">{c.canceled}</p>}

      {j.databases.length > 0 && (
        <div className="space-y-2">
          <div className="text-sm font-medium">{c.databasesTitle}</div>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left font-medium">{c.dbFrom}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{c.dbTo}</th>
                  <th className="px-2 py-1.5 text-left font-medium">{c.dbUser}</th>
                </tr>
              </thead>
              <tbody>
                {j.databases.map((d) => (
                  <tr key={d.to} className="border-t border-border">
                    <td className="break-all px-2 py-1.5 font-mono">{d.from}</td>
                    <td className="break-all px-2 py-1.5 font-mono">{d.to}</td>
                    <td className="break-all px-2 py-1.5 font-mono">{d.username}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {j.status !== "failed" && j.status !== "canceled" && <DbConfigWarning />}
        </div>
      )}

      {j.warnings.length > 0 && (
        <div className="space-y-1" data-testid="clone-warnings">
          <div className="text-sm font-medium">{c.warnings}</div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {j.warnings.map((w, i) => (
              <li key={i} className="flex gap-1.5 break-words">
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" /> <span className="min-w-0">{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {cancel.error && <p className="text-sm text-destructive">{errorText(cancel.error)}</p>}
      <div className="flex flex-wrap gap-2">
        {j.status === "running" && (
          <Button variant="outline" onClick={() => cancel.mutate({ id })} disabled={cancel.isPending} data-testid="clone-cancel">
            {cancel.isPending ? <Spinner /> : <X />} {cancel.isPending ? c.canceling : c.cancel}
          </Button>
        )}
        {j.status === "succeeded" && j.target.exists && (
          <Button asChild>
            <Link href={`/servers/${j.target.uuid}`}>{c.openCopy}</Link>
          </Button>
        )}
      </div>
    </div>
  );
}

/** Melding bovenaan de serverpagina zolang er een kopie van (of naar) deze server loopt. */
export function CloneBanner({ server }: { server: ServerDetail }) {
  const t = useT();
  const c = t.clone;
  const [open, setOpen] = useState<number | null>(null);
  const q = trpc.servers.clones.useQuery({ uuid: server.uuid }, { retry: false, refetchInterval: (query) => (query.state.data?.some((j) => j.status === "running") ? 3000 : 60_000) });
  const running = q.data?.find((j) => j.status === "running");
  if (!running) return null;
  const isTarget = running.target.uuid === server.uuid;
  return (
    <Alert data-testid="clone-banner">
      <Loader2 className="animate-spin" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
        <AlertDescription className="min-w-0 break-words">{isTarget ? c.bannerTarget(running.source.name) : c.bannerSource(running.target.name)}</AlertDescription>
        <Button size="sm" variant="outline" onClick={() => setOpen(running.id)}>
          {c.bannerView}
        </Button>
      </div>
      <Dialog open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent closeLabel={t.common.close} className="sm:max-w-xl">
          <DialogTitle className="pr-10 text-lg font-semibold">{c.progressTitle}</DialogTitle>
          <DialogDescription className="sr-only">{c.progressTitle}</DialogDescription>
          {open !== null && <CloneProgress id={open} />}
        </DialogContent>
      </Dialog>
    </Alert>
  );
}
