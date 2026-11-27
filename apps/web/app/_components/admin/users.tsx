"use client";
import { Ban, KeyRound, Search, ShieldCheck, UserPlus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { AdminUser } from "@panel/api";
import { DiscordId } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { AdminError } from "@/app/_components/admin/nodes";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName, UserAvatar } from "@/app/_components/user-avatar";
import { useDebounced } from "@/app/_hooks/use-debounced";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

export function UsersAdmin() {
  const t = useT();
  const u = t.admin.users;
  const utils = trpc.useUtils();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const users = trpc.admin.users.list.useInfiniteQuery({ limit: 50, search: q || undefined }, { getNextPageParam: (last) => last.nextCursor ?? undefined });
  const items = users.data?.pages.flatMap((p) => p.items) ?? [];
  const isId = DiscordId.safeParse(search.trim()).success;
  const exists = items.some((x) => x.discordId === search.trim());
  const create = trpc.admin.users.create.useMutation({
    onSuccess: () => void utils.admin.users.list.invalidate(),
  });

  return (
    <div className="space-y-4" data-testid="users-admin">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder={u.search} aria-label={u.search} value={search} onChange={(e) => (setSearch(e.target.value), create.reset())} className="pl-9" />
        </div>
        {isId && !exists && (
          <Button variant="secondary" onClick={() => create.mutate({ discordId: search.trim() })} disabled={create.isPending} title={u.precreateText}>
            {create.isPending ? <Spinner /> : <UserPlus />} {u.precreate}
          </Button>
        )}
        {create.isSuccess && (
          <span className="text-sm text-success" role="status">
            {u.created}
          </span>
        )}
      </div>
      {create.error && <AdminError error={create.error} />}
      {users.error ? (
        <QueryError error={users.error} />
      ) : users.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="users-table">
              <thead className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{u.colUser}</th>
                  <th className="px-4 py-2.5 font-medium">{u.colStatus}</th>
                  <th className="px-4 py-2.5 font-medium">{u.colServers}</th>
                  <th className="px-4 py-2.5 font-medium">{u.colLastLogin}</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                      {q ? u.noMatch(q) : u.empty}
                    </td>
                  </tr>
                )}
                {items.map((user) => (
                  <UserRow key={user.id} user={user} />
                ))}
              </tbody>
            </table>
          </div>
          {users.hasNextPage && (
            <div className="border-t border-border p-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => void users.fetchNextPage()} disabled={users.isFetchingNextPage}>
                {users.isFetchingNextPage && <Spinner />} {t.common.loadMore}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function UserRow({ user }: { user: AdminUser }) {
  const t = useT();
  const u = t.admin.users;
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState<null | "block" | "totp">(null);
  // de server bevestigt met {ok}; we tonen de nieuwe staat meteen en laden de lijst opnieuw
  const [blocked, setBlocked] = useState(user.blocked);
  const [totp, setTotp] = useState(user.totpEnabled);
  const invalidate = () => utils.admin.users.list.invalidate();
  const block = trpc.admin.users.setBlocked.useMutation({ onSuccess: (_r, v) => (setBlocked(v.blocked), setConfirm(null), void invalidate()) });
  const reset = trpc.admin.users.resetTotp.useMutation({ onSuccess: () => (setTotp(false), setConfirm(null), void invalidate()) });
  const error = block.error ?? reset.error;
  return (
    <tr className="align-top hover:bg-muted/30" data-testid="user-row">
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <UserAvatar user={user} className="size-8" />
          <div className="min-w-0">
            <Link href={`/admin/users/${user.id}`} className="block truncate font-medium hover:underline">
              {displayName(user)}
            </Link>
            <div className="flex items-center gap-0.5 font-mono text-xs text-muted-foreground">
              {user.discordId}
              <CopyButton value={user.discordId} label={t.common.copyX(u.discordId)} className="size-6" />
            </div>
          </div>
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {blocked ? <Badge variant="destructive">{u.blocked}</Badge> : <Badge variant="success">{u.active}</Badge>}
          {user.isAdmin && <Badge variant="warning">{u.admin}</Badge>}
          {totp && (
            <Badge variant="secondary">
              <ShieldCheck /> {u.totp}
            </Badge>
          )}
        </div>
      </td>
      <td className="px-4 py-3">{user.serverCount}</td>
      <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{user.lastLoginAt ? formatDate(user.lastLoginAt) : u.never}</td>
      <td className="px-4 py-3 text-right">
        {confirm ? (
          <div className="inline-flex flex-wrap items-center justify-end gap-2">
            <span className="text-xs text-muted-foreground">{t.admin.confirm}</span>
            <Button
              size="sm"
              variant="destructive"
              disabled={block.isPending || reset.isPending}
              onClick={() => (confirm === "block" ? block.mutate({ id: user.id, blocked: !blocked }) : reset.mutate({ id: user.id }))}
            >
              {(block.isPending || reset.isPending) && <Spinner />} {confirm === "block" ? (blocked ? u.unblock : u.block) : u.resetTotp}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              {t.common.cancel}
            </Button>
          </div>
        ) : (
          <div className="inline-flex gap-2">
            {totp && (
              <Button size="sm" variant="outline" onClick={() => setConfirm("totp")}>
                <KeyRound /> {u.resetTotp}
              </Button>
            )}
            <Button size="sm" variant="outline" className={blocked ? undefined : "text-destructive"} onClick={() => setConfirm("block")}>
              <Ban /> {blocked ? u.unblock : u.block}
            </Button>
          </div>
        )}
        {error && (
          <div className="mt-2 text-left">
            <AdminError error={error} />
          </div>
        )}
        {reset.isSuccess && (
          <p className="mt-1 text-xs text-success" role="status">
            {u.resetTotpDone}
          </p>
        )}
      </td>
    </tr>
  );
}
