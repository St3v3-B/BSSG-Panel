"use client";
import { Check, Star, Trash2, UserPlus } from "lucide-react";
import { useMemo, useState } from "react";
import type { Limits as LimitsT, ServerDetail, UserPublic } from "@panel/api";
import { DiscordId, Limits } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { AdminError, Field } from "@/app/_components/admin/nodes";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
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
