"use client";
import { ArrowLeft, Ban, KeyRound, LogOut, ShieldCheck, ShieldPlus, ShieldMinus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { metadataText } from "@/app/_components/admin/activity";
import { AdminError } from "@/app/_components/admin/nodes";
import { CopyButton } from "@/app/_components/copy-button";
import { QuotaEditor } from "@/app/_components/quota/quota-editor";
import { QueryError } from "@/app/_components/query-error";
import { StatusBadge } from "@/app/_components/status-badge";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName, UserAvatar } from "@/app/_components/user-avatar";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

type Op = "block" | "totp" | "admin" | "sessions";

export function UserDetail({ id }: { id: number }) {
  const t = useT();
  const u2 = t.admin2.user;
  const utils = trpc.useUtils();
  const user = trpc.admin.users.get.useQuery({ id });
  const admins = trpc.admin.admins.list.useQuery();
  const servers = trpc.admin.servers.list.useQuery({ limit: 100, ownerId: id });
  const activity = trpc.admin.activity.search.useQuery({ limit: 20, userId: id });
  const [confirm, setConfirm] = useState<Op | null>(null);
  const refresh = () => {
    setConfirm(null);
    void utils.admin.users.get.invalidate({ id });
    void utils.admin.users.list.invalidate();
    void utils.admin.admins.list.invalidate();
    void utils.admin.activity.search.invalidate();
  };
  const block = trpc.admin.users.setBlocked.useMutation({ onSuccess: refresh });
  const reset = trpc.admin.users.resetTotp.useMutation({ onSuccess: refresh });
  const revokeSessions = trpc.admin.users.revokeSessions.useMutation({ onSuccess: refresh });
  const addAdmin = trpc.admin.admins.add.useMutation({ onSuccess: refresh });
  const removeAdmin = trpc.admin.admins.remove.useMutation({ onSuccess: refresh });
  const u = user.data;
  const isOwner = !!u && !!admins.data?.some((a) => a.discordId === u.discordId && a.isOwner);
  const busy = block.isPending || reset.isPending || revokeSessions.isPending || addAdmin.isPending || removeAdmin.isPending;
  const error = block.error ?? reset.error ?? revokeSessions.error ?? addAdmin.error ?? removeAdmin.error;

  const run = () => {
    if (!u) return;
    if (confirm === "block") block.mutate({ id, blocked: !u.blocked });
    else if (confirm === "totp") reset.mutate({ id });
    else if (confirm === "sessions") revokeSessions.mutate({ id });
    else if (confirm === "admin") (u.isAdmin ? removeAdmin : addAdmin).mutate({ discordId: u.discordId });
  };
  const confirmLabel = confirm === "block" ? (u?.blocked ? u2.unblock : u2.block) : confirm === "totp" ? u2.resetTotp : confirm === "sessions" ? u2.revokeSessions : u?.isAdmin ? u2.removeAdmin : u2.makeAdmin;

  return (
    <div className="space-y-6" data-testid="user-detail">
      <Link href="/admin/users" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {u2.back}
      </Link>
      {user.error ? (
        <QueryError error={user.error} />
      ) : !u ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{u2.profile}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-4">
                <UserAvatar user={u} className="size-14" />
                <div className="min-w-0">
                  <div className="text-lg font-semibold">{displayName(u)}</div>
                  <div className="flex items-center gap-0.5 font-mono text-xs text-muted-foreground">
                    {u.discordId}
                    <CopyButton value={u.discordId} label={t.common.copyX(u2.discordId)} className="size-6" />
                  </div>
                </div>
                <div className="ml-auto flex flex-wrap justify-end gap-1" data-testid="user-badges">
                  {u.blocked ? <Badge variant="destructive">{u2.blocked}</Badge> : <Badge variant="success">{u2.active}</Badge>}
                  {isOwner ? <Badge variant="warning">{u2.owner}</Badge> : u.isAdmin && <Badge variant="warning">{u2.admin}</Badge>}
                  {u.totpEnabled ? (
                    <Badge variant="secondary">
                      <ShieldCheck /> {u2.totp}
                    </Badge>
                  ) : (
                    <Badge variant="outline">{u2.totpOff}</Badge>
                  )}
                </div>
              </div>
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-muted-foreground">{u2.createdAt}</dt>
                  <dd>{formatDate(u.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{u2.lastLogin}</dt>
                  <dd>{u.lastLoginAt ? formatDate(u.lastLoginAt) : u2.never}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{u2.servers}</dt>
                  <dd>{u.serverCount}</dd>
                </div>
              </dl>

              {error && <AdminError error={error} />}
              {confirm ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">{u2.confirm}</span>
                  <Button variant="destructive" disabled={busy} onClick={run}>
                    {busy && <Spinner />} {confirmLabel}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirm(null)}>
                    {t.common.cancel}
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" disabled={isOwner && !u.blocked} className={u.blocked ? undefined : "text-destructive"} onClick={() => setConfirm("block")}>
                    <Ban /> {u.blocked ? u2.unblock : u2.block}
                  </Button>
                  {u.totpEnabled && (
                    <Button variant="outline" onClick={() => setConfirm("totp")}>
                      <KeyRound /> {u2.resetTotp}
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setConfirm("sessions")} data-testid="user-revoke-sessions">
                    <LogOut /> {u2.revokeSessions}
                  </Button>
                  <Button variant="outline" disabled={isOwner} onClick={() => setConfirm("admin")}>
                    {u.isAdmin ? <ShieldMinus /> : <ShieldPlus />} {u.isAdmin ? u2.removeAdmin : u2.makeAdmin}
                  </Button>
                </div>
              )}
              {isOwner && <p className="text-xs text-muted-foreground">{u2.ownerLocked}</p>}
            </CardContent>
          </Card>

          <QuotaEditor userId={id} />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{u2.servers}</CardTitle>
            </CardHeader>
            <CardContent>
              {servers.error ? (
                <QueryError error={servers.error} />
              ) : !servers.data ? (
                <Skeleton className="h-16 rounded-lg" />
              ) : servers.data.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{u2.noServers}</p>
              ) : (
                <ul className="divide-y divide-border" data-testid="user-servers">
                  {servers.data.items.map((s) => (
                    <li key={s.uuid} className="flex items-center gap-3 py-2 text-sm">
                      <Link href={`/admin/servers/${s.uuid}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      <span className="text-muted-foreground">{s.templateName}</span>
                      <span className="ml-auto flex items-center gap-1">
                        {s.suspended && <Badge variant="warning">{t.admin2.list.suspended}</Badge>}
                        <StatusBadge status={s.status} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{u2.activity}</CardTitle>
            </CardHeader>
            <CardContent>
              {activity.error ? (
                <QueryError error={activity.error} />
              ) : !activity.data ? (
                <Skeleton className="h-16 rounded-lg" />
              ) : activity.data.items.length === 0 ? (
                <p className="text-sm text-muted-foreground">{u2.noActivity}</p>
              ) : (
                <ul className="divide-y divide-border text-sm" data-testid="user-activity">
                  {activity.data.items.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                      <span className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(a.at)}</span>
                      <code className="font-mono text-xs">{a.action}</code>
                      {a.serverName && <span>{a.serverName}</span>}
                      <span className="min-w-0 truncate text-xs text-muted-foreground">{metadataText(a.metadata)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
