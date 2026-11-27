"use client";
import { Check, Star, Trash2, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import type { Limits as LimitsT, ServerDetail, UserPublic } from "@panel/api";
import { DiscordId, Limits } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { AdminError, Field } from "@/app/_components/admin/nodes";
import { QueryError } from "@/app/_components/query-error";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { Label } from "@/app/_components/ui/label";
import { formatDate } from "@/app/_lib/format";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName, UserAvatar } from "@/app/_components/user-avatar";
import { useDebounced } from "@/app/_hooks/use-debounced";
import { useT } from "@/app/_lib/i18n";

function useInvalidateServer(uuid: string) {
  const utils = trpc.useUtils();
  return () => Promise.all([utils.servers.get.invalidate({ uuid }), utils.admin.servers.list.invalidate(), utils.servers.list.invalidate()]);
}

const LIMIT_KEYS = ["cpuPct", "ramMb", "swapMb", "diskMb"] as const;

/** Limieten via admin.servers.updateLimits. */
export function LimitsCard({ server }: { server: ServerDetail }) {
  const t = useT();
  const f = t.createForm;
  const invalidate = useInvalidateServer(server.uuid);
  const [vals, setVals] = useState<Record<keyof LimitsT, string>>(() => Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(server.limits[k])])) as Record<keyof LimitsT, string>);
  const parsed = Limits.safeParse(Object.fromEntries(LIMIT_KEYS.map((k) => [k, Number(vals[k])])));
  const save = trpc.admin.servers.updateLimits.useMutation({ onSuccess: () => void invalidate() });
  const errs: Partial<Record<keyof LimitsT, string>> = {};
  if (!parsed.success)
    for (const i of parsed.error.issues) {
      const k = i.path[0] as keyof LimitsT;
      errs[k] ??= Number.isNaN(Number(vals[k])) || vals[k] === "" ? f.limitNaN : i.code === "too_small" ? f.limitLow : i.code === "too_big" ? f.limitHigh : f.limitInvalid;
    }
  const labels = { cpuPct: f.cpu, ramMb: f.ram, swapMb: f.swap, diskMb: f.disk };
  return (
    <Card data-testid="limits-card">
      <CardHeader>
        <CardTitle className="text-base">{t.adminServer.limitsTitle}</CardTitle>
        <CardDescription>
          {t.adminServer.limitsText} {t.adminServer.limitsUnits}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (parsed.success) save.mutate({ uuid: server.uuid, limits: parsed.data });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-4">
            {LIMIT_KEYS.map((k) => (
              <Field key={k} id={`lim-${k}`} label={labels[k]} hint={errs[k] ? <span className="text-destructive">{errs[k]}</span> : undefined}>
                <Input
                  id={`lim-${k}`}
                  type="number"
                  inputMode="numeric"
                  value={vals[k]}
                  aria-invalid={!!errs[k] || undefined}
                  onChange={(e) => (setVals((c) => ({ ...c, [k]: e.target.value })), save.reset())}
                />
              </Field>
            ))}
          </div>
          {save.error && <AdminError error={save.error} />}
          {save.isSuccess && (
            <p className="text-sm text-success" role="status">
              {t.adminServer.limitsSaved}
            </p>
          )}
          <Button type="submit" disabled={!parsed.success || save.isPending}>
            {save.isPending && <Spinner />} {t.adminServer.limitsSave}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Eigenaar via admin.servers.updateOwner: zoeken of vooraf aanmaken op Discord-ID. */
export function OwnerCard({ server }: { server: ServerDetail }) {
  const t = useT();
  const f = t.createForm;
  const invalidate = useInvalidateServer(server.uuid);
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [picked, setPicked] = useState<UserPublic | null>(null);
  const users = trpc.admin.users.list.useQuery({ limit: 20, search: q || undefined }, { placeholderData: (p) => p });
  const save = trpc.admin.servers.updateOwner.useMutation({ onSuccess: () => (setPicked(null), setSearch(""), void invalidate()) });
  const createUser = trpc.admin.users.create.useMutation({ onSuccess: (u) => (setPicked(u), void utils.admin.users.list.invalidate()) });
  const isId = DiscordId.safeParse(search.trim()).success;
  const exact = users.data?.items.find((u) => u.discordId === search.trim());
  return (
    <Card data-testid="owner-card">
      <CardHeader>
        <CardTitle className="text-base">{t.adminServer.ownerTitle}</CardTitle>
        <CardDescription>{t.adminServer.ownerText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
          <UserAvatar user={server.owner} className="size-7" />
          <div className="min-w-0 flex-1">
            <div className="text-xs text-muted-foreground">{t.adminServer.ownerCurrent}</div>
            <div className="truncate font-medium">{displayName(server.owner)}</div>
          </div>
        </div>
        <Input aria-label={t.adminServer.ownerChange} placeholder={f.ownerSearch} value={search} onChange={(e) => (setSearch(e.target.value), save.reset())} />
        {(q || picked) && (
          <div className="max-h-56 overflow-y-auto rounded-md border border-border" role="listbox" aria-label={f.users}>
            {users.data?.items
              .filter((u) => u.id !== server.owner.id)
              .map((u) => (
                <button
                  key={u.id}
                  type="button"
                  role="option"
                  aria-selected={picked?.id === u.id}
                  onClick={() => setPicked(u)}
                  className={cn("flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted", picked?.id === u.id && "bg-primary/10")}
                >
                  <UserAvatar user={u} className="size-7" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{displayName(u)}</span>
                    <span className="block font-mono text-xs text-muted-foreground">{u.discordId}</span>
                  </span>
                  {!u.name && <Badge variant="secondary">{f.notSignedIn}</Badge>}
                  {picked?.id === u.id && <Check className="size-4 text-primary" />}
                </button>
              ))}
            {users.data && users.data.items.length === 0 && !isId && <p className="px-3 py-3 text-sm text-muted-foreground">{f.noUsers}</p>}
          </div>
        )}
        {isId && !exact && !picked && (
          <Button size="sm" variant="secondary" onClick={() => createUser.mutate({ discordId: search.trim() })} disabled={createUser.isPending}>
            {createUser.isPending ? <Spinner /> : <UserPlus />} {f.precreate}
          </Button>
        )}
        {(save.error || createUser.error) && <AdminError error={save.error ?? createUser.error} />}
        {save.isSuccess && (
          <p className="text-sm text-success" role="status">
            {t.adminServer.ownerSaved}
          </p>
        )}
        {picked && (
          <Button onClick={() => save.mutate({ uuid: server.uuid, ownerId: picked.id })} disabled={save.isPending}>
            {save.isPending && <Spinner />} {t.adminServer.ownerSave}: {displayName(picked)}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/** Poorten via admin.servers.updateAllocations; alleen game-servers. De eerste is primair. */
export function PortsCard({ server }: { server: ServerDetail }) {
  const t = useT();
  const invalidate = useInvalidateServer(server.uuid);
  const utils = trpc.useUtils();
  const list = trpc.admin.allocations.list.useQuery({ nodeId: server.node.id });
  const initial = useMemo(() => [...server.allocations].sort((a, b) => Number(b.primary) - Number(a.primary)).map((a) => a.id), [server.allocations]);
  const [ids, setIds] = useState<number[]>(initial);
  const save = trpc.admin.servers.updateAllocations.useMutation({
    onSuccess: () => Promise.all([invalidate(), utils.admin.allocations.list.invalidate({ nodeId: server.node.id })]),
  });
  const options = (list.data ?? []).filter((a) => a.serverUuid === null || a.serverUuid === server.uuid);
  const toggle = (id: number) => (setIds((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id])), save.reset());
  const primary = (id: number) => (setIds((c) => [id, ...c.filter((x) => x !== id)]), save.reset());
  const changed = ids.join() !== initial.join();
  return (
    <Card data-testid="ports-card">
      <CardHeader>
        <CardTitle className="text-base">{t.adminServer.portsTitle}</CardTitle>
        <CardDescription>{t.adminServer.portsText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!list.data ? (
          <Skeleton className="h-16" />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {options.map((a) => {
              const idx = ids.indexOf(a.id);
              return (
                <div key={a.id} className={cn("flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm", idx >= 0 && "border-primary/50 bg-primary/5")} data-testid="port-option">
                  <Checkbox id={`port-${a.id}`} checked={idx >= 0} onChange={() => toggle(a.id)} />
                  <label htmlFor={`port-${a.id}`} className="flex-1 cursor-pointer font-mono">
                    {a.ip}:{a.port}
                  </label>
                  {a.serverUuid === server.uuid && idx < 0 && <Badge variant="secondary">{t.adminServer.current}</Badge>}
                  {idx === 0 && (
                    <Badge>
                      <Star /> {t.createForm.primary}
                    </Badge>
                  )}
                  {idx > 0 && (
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => primary(a.id)}>
                      {t.createForm.makePrimary}
                    </Button>
                  )}
                </div>
              );
            })}
            {options.length === 0 && <p className="text-sm text-muted-foreground">{t.createForm.noPorts}</p>}
          </div>
        )}
        {ids.length === 0 && <p className="text-xs text-destructive">{t.adminServer.portsNeedOne}</p>}
        {save.error && <AdminError error={save.error} />}
        {save.isSuccess && (
          <p className="text-sm text-success" role="status">
            {t.adminServer.portsSaved}
          </p>
        )}
        <Button onClick={() => save.mutate({ uuid: server.uuid, allocationIds: ids })} disabled={!changed || ids.length === 0 || save.isPending}>
          {save.isPending && <Spinner />} {t.adminServer.portsSave}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Verplaatsen naar een andere node via admin.servers.transfer (gestopte kopie, bron pas weg na succes). */
export function MoveNodeCard({ server, onMoved }: { server: ServerDetail; onMoved?: () => void }) {
  const t = useT();
  const utils = trpc.useUtils();
  const nodes = trpc.admin.nodes.list.useQuery();
  const [nodeId, setNodeId] = useState<number | null>(null);
  const [allocId, setAllocId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState(false);
  const others = (nodes.data ?? []).filter((n) => n.id !== server.node.id);
  const target = nodeId ?? others[0]?.id ?? null;
  const allocs = trpc.admin.allocations.list.useQuery({ nodeId: target ?? 0 }, { enabled: target !== null && server.type === "game" });
  const free = (allocs.data ?? []).filter((a) => a.serverUuid === null);
  const move = trpc.admin.servers.transfer.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.servers.get.invalidate({ uuid: server.uuid }), utils.admin.servers.list.invalidate(), utils.servers.list.invalidate(), utils.admin.allocations.list.invalidate(), utils.admin.nodes.get.invalidate()]);
      onMoved?.();
    },
  });
  const targetName = others.find((n) => n.id === target)?.name ?? "";
  return (
    <Card data-testid="move-card">
      <CardHeader>
        <CardTitle className="text-base">{t.adminServer.moveTitle}</CardTitle>
        <CardDescription>{t.adminServer.moveText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {nodes.data && others.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.adminServer.moveNoOther}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id="move-node" label={t.adminServer.moveNode}>
              <Select id="move-node" value={target ?? ""} onChange={(e) => (setNodeId(Number(e.target.value)), setAllocId(null), setConfirm(false), move.reset())}>
                {others.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.name} ({n.fqdn})
                  </option>
                ))}
              </Select>
            </Field>
            {server.type === "game" && (
              <Field id="move-alloc" label={t.adminServer.movePort}>
                <Select id="move-alloc" value={allocId ?? ""} onChange={(e) => setAllocId(e.target.value ? Number(e.target.value) : null)}>
                  <option value="">{t.adminServer.moveFirstFree}</option>
                  {free.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.ip}:{a.port}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
        )}
        {move.error && <AdminError error={move.error} />}
        {move.isSuccess && (
          <p className="text-sm text-success" role="status">
            {t.adminServer.moveDone}
          </p>
        )}
        {move.isSuccess && <p className="text-sm text-muted-foreground">{t.adminServer.moveDnsHint}</p>}
        {move.isPending && <p className="text-sm text-muted-foreground">{t.adminServer.moving}</p>}
        {target !== null &&
          (confirm ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{t.adminServer.moveConfirm(targetName)}</span>
              <Button onClick={() => move.mutate({ uuid: server.uuid, nodeId: target, ...(allocId ? { allocationIds: [allocId] } : {}) })} disabled={move.isPending}>
                {move.isPending && <Spinner />} {t.adminServer.moveButton}
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)} disabled={move.isPending}>
                {t.common.cancel}
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => setConfirm(true)}>
              {t.adminServer.moveButton}
            </Button>
          ))}
      </CardContent>
    </Card>
  );
}

/** Verwijderen via admin.servers.delete; bevestigen door de servernaam in te typen. */
export function DeleteServerCard({ server, onDeleted }: { server: ServerDetail; onDeleted: () => void }) {
  const t = useT();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const del = trpc.admin.servers.delete.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.admin.servers.list.invalidate(), utils.servers.list.invalidate()]);
      onDeleted();
    },
  });
  const match = typed.trim() === server.name;
  return (
    <Card className="border-destructive/40" data-testid="delete-card">
      <CardHeader>
        <CardTitle className="text-base text-destructive">{t.adminServer.deleteTitle}</CardTitle>
        <CardDescription>{t.adminServer.deleteText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {open ? (
          <div role="alertdialog" aria-label={t.adminServer.deleteTitle} className="space-y-3">
            <Field id="delete-confirm" label={t.adminServer.deleteConfirm(server.name)}>
              <Input id="delete-confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
            {del.error && <AdminError error={del.error} />}
            <div className="flex gap-2">
              <Button variant="destructive" disabled={!match || del.isPending} onClick={() => del.mutate({ uuid: server.uuid })}>
                {del.isPending ? <Spinner /> : <Trash2 />} {t.adminServer.deleteButton}
              </Button>
              <Button variant="ghost" onClick={() => (setOpen(false), setTyped(""))}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" className="text-destructive" onClick={() => setOpen(true)}>
            <Trash2 /> {t.adminServer.deleteOpen}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function SuspendSection({ uuid, suspended }: { uuid: string; suspended: { reason: string | null; at: Date } | null }) {
  const t = useT();
  const s2 = t.admin2.server;
  const utils = trpc.useUtils();
  const [reason, setReason] = useState("");
  const [confirm, setConfirm] = useState(false);
  const m = trpc.admin.servers.setSuspended.useMutation({
    onSuccess: () => {
      setConfirm(false);
      setReason("");
      void utils.servers.get.invalidate({ uuid });
      void utils.admin.servers.list.invalidate();
    },
  });
  return (
    <Card data-testid="suspend-section">
      <CardHeader>
        <CardTitle className="text-base">{s2.suspendTitle}</CardTitle>
        <CardDescription>{s2.suspendText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {suspended ? (
          <div className="text-sm" data-testid="suspended-info">
            <div className="font-medium">{s2.suspendedSince(formatDate(suspended.at))}</div>
            {suspended.reason && <div className="text-muted-foreground">{suspended.reason}</div>}
          </div>
        ) : (
          <div className="max-w-md space-y-1.5">
            <Label htmlFor="suspend-reason">{s2.reasonLabel}</Label>
            <Input id="suspend-reason" value={reason} maxLength={500} placeholder={s2.reasonPlaceholder} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
        {m.error && <AdminError error={m.error} />}
        {m.isSuccess && !confirm && (
          <p className="text-sm text-success" role="status">
            {suspended ? s2.suspendDone : s2.unsuspendDone}
          </p>
        )}
        {confirm ? (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">{t.admin.confirm}</span>
            <Button variant={suspended ? "default" : "destructive"} disabled={m.isPending} onClick={() => m.mutate({ uuid, suspended: !suspended, reason: reason.trim() || null })}>
              {m.isPending && <Spinner />} {suspended ? s2.unsuspend : s2.suspend}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {t.common.cancel}
            </Button>
          </div>
        ) : (
          <Button variant={suspended ? "default" : "outline"} className={suspended ? undefined : "text-destructive"} onClick={() => (m.reset(), setConfirm(true))}>
            {suspended ? s2.unsuspend : s2.suspend}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function TemplateSection({ uuid, type, currentName }: { uuid: string; type: "game" | "web"; currentName: string }) {
  const t = useT();
  const s2 = t.admin2.server;
  const utils = trpc.useUtils();
  const templates = trpc.admin.templates.list.useQuery();
  const options = templates.data?.filter((x) => x.type === type && x.name !== currentName) ?? [];
  const [templateId, setTemplateId] = useState<number | "">("");
  const [reinstall, setReinstall] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const m = trpc.admin.servers.changeTemplate.useMutation({
    onSuccess: () => {
      setConfirm(false);
      setTemplateId("");
      void utils.servers.get.invalidate({ uuid });
      void utils.admin.servers.list.invalidate();
    },
  });
  return (
    <Card data-testid="template-section">
      <CardHeader>
        <CardTitle className="text-base">{s2.templateTitle}</CardTitle>
        <CardDescription>{s2.templateText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {templates.error ? (
          <QueryError error={templates.error} />
        ) : options.length === 0 && templates.data ? (
          <p className="text-sm text-muted-foreground">{s2.templateNone}</p>
        ) : (
          <>
            <div className="max-w-md space-y-1.5">
              <Label htmlFor="new-template">{s2.templateSelect}</Label>
              <Select id="new-template" value={templateId} onChange={(e) => (setTemplateId(e.target.value ? Number(e.target.value) : ""), setConfirm(false))}>
                <option value="">–</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} (v{o.version})
                  </option>
                ))}
              </Select>
              <p className="text-xs text-muted-foreground">
                {s2.current}: {currentName}
              </p>
            </div>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={reinstall} onChange={(e) => setReinstall(e.target.checked)} className="mt-0.5" />
              <span>
                {s2.reinstall}
                <span className="block text-xs text-muted-foreground">{s2.reinstallHint}</span>
              </span>
            </label>
          </>
        )}
        {m.error && <AdminError error={m.error} />}
        {m.isSuccess && (
          <p className="text-sm text-success" role="status">
            {s2.templateDone}
          </p>
        )}
        {templateId !== "" &&
          (confirm ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">{t.admin.confirm}</span>
              <Button variant="destructive" disabled={m.isPending} onClick={() => m.mutate({ uuid, templateId, reinstall })}>
                {m.isPending && <Spinner />} {s2.templateChange}
              </Button>
              <Button variant="ghost" onClick={() => setConfirm(false)}>
                {t.common.cancel}
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => (m.reset(), setConfirm(true))}>
              {s2.templateChange}
            </Button>
          ))}
      </CardContent>
    </Card>
  );
}

/** Game-server: domeinen (HTTP-map, Minecraft-SRV) wel of niet toestaan. */
export function DomainsAllowedSection({ uuid, allowed }: { uuid: string; allowed: boolean }) {
  const t = useT();
  const d = t.admin2.server;
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState(false);
  const m = trpc.admin.servers.setDomainsAllowed.useMutation({
    onSuccess: () => {
      setConfirm(false);
      void utils.servers.get.invalidate({ uuid });
      void utils.domains.list.invalidate({ uuid });
    },
  });
  return (
    <Card data-testid="domains-allowed-section">
      <CardHeader>
        <CardTitle className="text-base">{d.domainsTitle}</CardTitle>
        <CardDescription>{d.domainsText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={allowed}
            disabled={m.isPending}
            onChange={(e) => {
              if (e.target.checked) m.mutate({ uuid, allowed: true });
              else setConfirm(true);
            }}
          />
          {d.domainsToggle}
        </label>
        {confirm && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">{d.domainsOffWarning}</span>
            <Button variant="destructive" disabled={m.isPending} onClick={() => m.mutate({ uuid, allowed: false })}>
              {m.isPending && <Spinner />} {d.domainsOff}
            </Button>
            <Button variant="ghost" onClick={() => setConfirm(false)}>
              {t.common.cancel}
            </Button>
          </div>
        )}
        {m.error && <AdminError error={m.error} />}
      </CardContent>
    </Card>
  );
}
