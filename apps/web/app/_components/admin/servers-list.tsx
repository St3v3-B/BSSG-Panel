"use client";
import { Ban, CheckCircle2, Play, Plus, RotateCw, Search, Square, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { PowerAction, ServerSummary } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { StatusBadge } from "@/app/_components/status-badge";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName } from "@/app/_components/user-avatar";
import { useDebounced } from "@/app/_hooks/use-debounced";
import { errorText } from "@/app/_lib/errors";
import { formatCpuLimit, formatMb } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

export type BulkAction = PowerAction | "suspend" | "unsuspend";
interface Result {
  uuid: string;
  name: string;
  ok: boolean;
  error?: string;
}

export function AdminServersList() {
  const t = useT();
  const l = t.admin2.list;
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [f, setF] = useState<{ ownerId?: number; nodeId?: number; type?: "game" | "web"; status?: ServerSummary["status"]; suspended?: boolean }>({});
  const users = trpc.admin.users.list.useQuery({ limit: 100 });
  const nodes = trpc.admin.nodes.list.useQuery();
  const servers = trpc.admin.servers.list.useInfiniteQuery({ limit: 50, search: q || undefined, ...f }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const items = servers.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = !!q || Object.values(f).some((v) => v !== undefined);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<{ action: BulkAction; uuids: string[] } | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const power = trpc.servers.power.useMutation();
  const suspend = trpc.admin.servers.setSuspended.useMutation();

  const label: Record<BulkAction, string> = { start: l.start, stop: l.stop, restart: l.restart, kill: l.stop, suspend: l.suspend, unsuspend: l.unsuspend };
  const setFilter = (k: keyof typeof f, v: string, parse: (s: string) => unknown = (s) => s) => setF((o) => ({ ...o, [k]: v === "" ? undefined : parse(v) }));

  async function run(action: BulkAction, uuids: string[], why: string) {
    setBusy(true);
    const out: Result[] = [];
    for (const uuid of uuids) {
      const name = items.find((s) => s.uuid === uuid)?.name ?? uuid;
      try {
        if (action === "suspend" || action === "unsuspend") await suspend.mutateAsync({ uuid, suspended: action === "suspend", reason: why.trim() || null });
        else await power.mutateAsync({ uuid, action });
        out.push({ uuid, name, ok: true });
      } catch (e) {
        out.push({ uuid, name, ok: false, error: errorText(e) });
      }
    }
    setBusy(false);
    setPending(null);
    setReason("");
    setSelected(new Set());
    setResults(out);
    await utils.admin.servers.list.invalidate();
  }

  const toggle = (uuid: string) => setSelected((s) => (s.has(uuid) ? new Set([...s].filter((x) => x !== uuid)) : new Set(s).add(uuid)));
  const allSelected = items.length > 0 && items.every((s) => selected.has(s.uuid));
  const ask = (action: BulkAction, uuids: string[]) => (setResults(null), setPending({ action, uuids }));
  const quick = (action: PowerAction, uuid: string) => void (setResults(null), run(action, [uuid], ""));

  return (
    <div className="space-y-4" data-testid="admin-servers">
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder={l.search} aria-label={l.search} value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <FilterSelect label={l.filterOwner} value={f.ownerId ?? ""} onChange={(v) => setFilter("ownerId", v, Number)} any={l.any}>
          {users.data?.items.map((u) => (
            <option key={u.id} value={u.id}>
              {displayName(u)}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label={l.filterNode} value={f.nodeId ?? ""} onChange={(v) => setFilter("nodeId", v, Number)} any={l.any}>
          {nodes.data?.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label={l.filterType} value={f.type ?? ""} onChange={(v) => setFilter("type", v)} any={l.any}>
          <option value="game">{l.game}</option>
          <option value="web">{l.web}</option>
        </FilterSelect>
        <FilterSelect label={l.filterStatus} value={f.status ?? ""} onChange={(v) => setFilter("status", v)} any={l.any}>
          {Object.entries(t.status).map(([k, v]) => (
            <option key={k} value={k}>
              {v as string}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label={l.filterSuspended} value={f.suspended === undefined ? "" : String(f.suspended)} onChange={(v) => setFilter("suspended", v, (s) => s === "true")} any={l.any}>
          <option value="true">{l.onlySuspended}</option>
          <option value="false">{l.notSuspended}</option>
        </FilterSelect>
      </div>

      {selected.size > 0 && !pending && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-2" data-testid="bulk-bar">
          <span className="px-2 text-sm">{l.selected(selected.size)}</span>
          {(["start", "stop", "restart", "suspend", "unsuspend"] as const).map((a) => (
            <Button key={a} size="sm" variant="outline" onClick={() => ask(a, [...selected])}>
              {label[a]}
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {l.clear}
          </Button>
        </div>
      )}

      {pending && (
        <Card className="space-y-3 p-4" data-testid="bulk-confirm">
          <div className="font-medium">{l.bulkTitle(label[pending.action], pending.uuids.length)}</div>
          <p className="text-sm text-muted-foreground">{l.bulkText}</p>
          <ul className="max-h-32 overflow-auto text-sm text-muted-foreground">
            {pending.uuids.map((u) => (
              <li key={u}>{items.find((s) => s.uuid === u)?.name ?? u}</li>
            ))}
          </ul>
          {pending.action === "suspend" && <Input aria-label={l.reason} placeholder={l.reason} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />}
          <div className="flex gap-2">
            <Button variant={pending.action === "start" ? "default" : "destructive"} disabled={busy} onClick={() => void run(pending.action, pending.uuids, reason)}>
              {busy && <Spinner />} {busy ? l.running : l.confirm}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setPending(null)}>
              {t.common.cancel}
            </Button>
          </div>
        </Card>
      )}

      {results && (
        <Card className="space-y-2 p-4" data-testid="bulk-results">
          <ul className="space-y-1 text-sm">
            {results.map((r) => (
              <li key={r.uuid} className="flex items-start gap-2" data-testid="bulk-result" data-ok={r.ok}>
                {r.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />}
                <span className="font-medium">{r.name}</span>
                <span className={r.ok ? "text-muted-foreground" : "text-destructive"}>{r.ok ? l.resultOk : `${l.resultFailed}: ${r.error}`}</span>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="ghost" onClick={() => setResults(null)}>
            {l.close}
          </Button>
        </Card>
      )}

      {servers.error ? (
        <QueryError error={servers.error} />
      ) : servers.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="admin-server-table">
              <thead className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 px-4 py-2.5">
                    <Checkbox aria-label={l.selectAll} checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((s) => s.uuid)))} />
                  </th>
                  <th className="px-4 py-2.5 font-medium">{l.colName}</th>
                  <th className="px-4 py-2.5 font-medium">{l.colStatus}</th>
                  <th className="px-4 py-2.5 font-medium">{l.colOwner}</th>
                  <th className="px-4 py-2.5 font-medium">{l.colTemplate}</th>
                  <th className="px-4 py-2.5 font-medium">{l.colAddress}</th>
                  <th className="px-4 py-2.5 font-medium">{l.colLimits}</th>
                  <th className="px-4 py-2.5 text-right font-medium">{l.colActions}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-muted-foreground">
                      {filtered ? l.noMatch : l.empty}
                    </td>
                  </tr>
                )}
                {items.map((s) => (
                  <tr key={s.uuid} className="hover:bg-muted/30" data-testid="admin-server-row">
                    <td className="px-4 py-3">
                      <Checkbox aria-label={l.selectRow(s.name)} checked={selected.has(s.uuid)} onChange={() => toggle(s.uuid)} />
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/servers/${s.uuid}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      <div className="font-mono text-xs text-muted-foreground">{s.shortId}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1">
                        <StatusBadge status={s.status} />
                        {s.suspended && (
                          <Badge variant="warning" title={s.suspended.reason ?? undefined}>
                            <Ban /> {l.suspended}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/admin/users/${s.owner.id}`} className="hover:underline">
                        {displayName(s.owner)}
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      {s.templateName}
                      <div className="text-xs text-muted-foreground">{s.nodeName}</div>
                    </td>
                    <td className="px-4 py-3">
                      {s.primaryAddress ? (
                        <span className="inline-flex items-center gap-1">
                          <code className="font-mono text-xs">{s.primaryAddress}</code>
                          <CopyButton value={s.primaryAddress} label={t.server.copyAddress} />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                      {formatCpuLimit(s.limits.cpuPct)} · {formatMb(s.limits.ramMb)} · {s.limits.diskMb ? formatMb(s.limits.diskMb) : "∞"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-1">
                        <Button size="icon" variant="ghost" title={l.start} aria-label={`${l.start} ${s.name}`} disabled={busy} onClick={() => quick("start", s.uuid)}>
                          <Play />
                        </Button>
                        <Button size="icon" variant="ghost" title={l.stop} aria-label={`${l.stop} ${s.name}`} disabled={busy} onClick={() => quick("stop", s.uuid)}>
                          <Square />
                        </Button>
                        <Button size="icon" variant="ghost" title={l.restart} aria-label={`${l.restart} ${s.name}`} disabled={busy} onClick={() => quick("restart", s.uuid)}>
                          <RotateCw />
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => ask(s.suspended ? "unsuspend" : "suspend", [s.uuid])}>
                          {s.suspended ? l.unsuspend : l.suspend}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {servers.hasNextPage && (
            <div className="border-t border-border p-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => void servers.fetchNextPage()} disabled={servers.isFetchingNextPage}>
                {servers.isFetchingNextPage && <Spinner />} {t.common.loadMore}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function FilterSelect({ label, value, onChange, any, children }: { label: string; value: string | number; onChange: (v: string) => void; any: string; children: React.ReactNode }) {
  return (
    <label className="w-40 space-y-1.5 text-sm font-medium">
      <span>{label}</span>
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{any}</option>
        {children}
      </Select>
    </label>
  );
}

export function CreateServerButton() {
  const t = useT();
  return (
    <Button asChild>
      <Link href="/admin/servers/new" data-testid="create-server-link">
        <Plus /> {t.admin2.list.create}
      </Link>
    </Button>
  );
}
