"use client";
import { ArrowLeft, Ban, CircleAlert, Fingerprint, KeyRound, LogOut, ShieldCheck, ShieldPlus, ShieldMinus, UserRound } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { LoginUsername } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { metadataText } from "@/app/_components/admin/activity";
import { AdminError } from "@/app/_components/admin/nodes";
import { CopyButton } from "@/app/_components/copy-button";
import { QuotaEditor } from "@/app/_components/quota/quota-editor";
import { QueryError } from "@/app/_components/query-error";
import { StatusBadge } from "@/app/_components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
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

          <PasswordLoginSection id={id} name={u.name} />

          <PasskeysSection id={id} />

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

/** Voorstel voor een loginnaam op basis van de Discord-naam: kleine letters, zonder accenten, alleen a-z 0-9 . _ -. */
export function suggestUsername(name: string | null, id: number): string {
  const base = (name ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, ".")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[._-]+/, "")
    .slice(0, 32)
    .replace(/[._-]+$/, "");
  return base.length >= 3 ? base : `user${id}`;
}

function PasswordLoginSection({ id, name }: { id: number; name: string | null }) {
  const t = useT();
  const p = t.admin2.user.pw;
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery(undefined, { retry: false });
  const status = trpc.admin.users.getPasswordLogin.useQuery({ id });
  const [mode, setMode] = useState<null | "edit" | "disable">(null);
  const [username, setUsername] = useState("");
  const [generated, setGenerated] = useState<string | null>(null);
  const after = () => {
    setMode(null);
    void utils.admin.users.list.invalidate();
    void utils.admin.users.get.invalidate({ id });
    void utils.admin.activity.search.invalidate();
  };
  const set = trpc.admin.users.setPasswordLogin.useMutation({
    onSuccess: (r) => {
      utils.admin.users.getPasswordLogin.setData({ id }, r.status);
      setGenerated(r.password);
      after();
    },
  });
  const disable = trpc.admin.users.disablePasswordLogin.useMutation({
    onSuccess: (r) => {
      utils.admin.users.getPasswordLogin.setData({ id }, r);
      setGenerated(null);
      after();
    },
  });
  const s = status.data;
  const usernameOk = LoginUsername.safeParse(username).success;
  const isSelf = me.data?.user.id === id;
  const openEdit = () => {
    set.reset();
    setUsername(s?.username ?? suggestUsername(name, id));
    setGenerated(null);
    setMode("edit");
  };

  return (
    <Card data-testid="user-password-login">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRound className={s?.enabled ? "size-5 text-success" : "size-5 text-muted-foreground"} />
            {p.title}
          </CardTitle>
          {s && <Badge variant={s.enabled ? "success" : "secondary"}>{s.enabled && s.username ? p.onAs(s.username) : p.off}</Badge>}
        </div>
        <CardDescription>{p.text}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.error ? (
          <QueryError error={status.error} />
        ) : !s ? (
          <Skeleton className="h-10 rounded-lg" />
        ) : (
          <>
            {generated && (
              <Alert variant="warning" data-testid="user-password-generated">
                <KeyRound />
                <div className="min-w-0 space-y-2">
                  <AlertTitle>{p.generatedTitle}</AlertTitle>
                  <AlertDescription>{p.generatedText}</AlertDescription>
                  <div className="flex items-center gap-1 rounded-md border border-border bg-background px-3 py-2 text-foreground">
                    <code className="flex-1 break-all font-mono text-sm" data-testid="user-password-value">
                      {generated}
                    </code>
                    <CopyButton value={generated} label={p.copy} />
                  </div>
                  <Button size="sm" variant="outline" onClick={() => setGenerated(null)} data-testid="user-password-saved">
                    {p.saved}
                  </Button>
                </div>
              </Alert>
            )}
            {s.enabled && (
              <div className="space-y-1 text-sm text-muted-foreground">
                {s.updatedAt && <p>{p.updated(formatDate(s.updatedAt))}</p>}
                {s.setByAdmin && <p>{p.setByAdmin}</p>}
              </div>
            )}
            {(set.error ?? disable.error) && <AdminError error={set.error ?? disable.error} />}
            {mode === "edit" ? (
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (usernameOk) set.mutate({ id, username: username.trim().toLowerCase() });
                }}
              >
                <div className="space-y-2">
                  <Label htmlFor="user-pw-username">{p.username}</Label>
                  <Input id="user-pw-username" autoComplete="off" autoCapitalize="none" spellCheck={false} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} aria-invalid={(!!username && !usernameOk) || undefined} disabled={set.isPending} className="font-mono sm:max-w-xs" />
                  <p className={username && !usernameOk ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{username && !usernameOk ? p.invalidUsername : p.usernameHint}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" disabled={!usernameOk || set.isPending} data-testid="user-pw-submit">
                    {set.isPending && <Spinner />} {p.generate}
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setMode(null)}>
                    {t.common.cancel}
                  </Button>
                </div>
              </form>
            ) : mode === "disable" ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-muted-foreground">{p.disableSure}</span>
                <Button variant="destructive" disabled={disable.isPending} onClick={() => disable.mutate({ id })} data-testid="user-pw-disable-confirm">
                  {disable.isPending && <Spinner />} {p.disable}
                </Button>
                <Button variant="ghost" onClick={() => setMode(null)}>
                  {t.common.cancel}
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={openEdit} data-testid="user-pw-edit">
                  <KeyRound /> {s.enabled ? p.reset : p.enable}
                </Button>
                {s.enabled && (
                  <Button variant="outline" className="text-destructive" onClick={() => (disable.reset(), setMode("disable"))} data-testid="user-pw-disable">
                    {p.disable}
                  </Button>
                )}
              </div>
            )}
            {isSelf && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <CircleAlert className="mt-px size-3.5 shrink-0" /> {p.self}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PasskeysSection({ id }: { id: number }) {
  const t = useT();
  const p = t.admin2.user.passkeys;
  const utils = trpc.useUtils();
  const list = trpc.admin.users.passkeys.useQuery({ id });
  const [confirm, setConfirm] = useState(false);
  const [deleted, setDeleted] = useState<number | null>(null);
  const del = trpc.admin.users.deletePasskeys.useMutation({
    onSuccess: async (r) => {
      setConfirm(false);
      setDeleted(r.deleted);
      await utils.admin.users.passkeys.invalidate({ id });
      void utils.admin.activity.search.invalidate();
    },
  });
  const keys = list.data;
  return (
    <Card data-testid="user-passkeys">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Fingerprint className={keys?.length ? "size-5 text-success" : "size-5 text-muted-foreground"} />
            {p.title}
          </CardTitle>
          {keys && <Badge variant={keys.length ? "success" : "secondary"} data-testid="user-passkey-count">{p.count(keys.length)}</Badge>}
        </div>
        <CardDescription>{p.text}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.error ? (
          <QueryError error={list.error} />
        ) : !keys ? (
          <Skeleton className="h-10 rounded-lg" />
        ) : (
          <>
            {deleted !== null && <p className="text-sm text-success" data-testid="user-passkeys-deleted">{p.deleted(deleted)}</p>}
            {keys.length === 0 ? (
              <p className="text-sm text-muted-foreground">{p.none}</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {keys.map((k) => (
                  <li key={k.id} className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium">{k.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {p.created(formatDate(k.createdAt))} · {k.lastUsedAt ? p.lastUsed(formatDate(k.lastUsedAt)) : p.neverUsed}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {del.error && <AdminError error={del.error} />}
            {keys.length > 0 &&
              (confirm ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">{p.deleteSure(keys.length)}</span>
                  <Button variant="destructive" disabled={del.isPending} onClick={() => del.mutate({ id })} data-testid="user-passkeys-delete-confirm">
                    {del.isPending && <Spinner />} {p.deleteAll}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirm(false)}>
                    {t.common.cancel}
                  </Button>
                </div>
              ) : (
                <Button variant="outline" className="text-destructive" onClick={() => (del.reset(), setDeleted(null), setConfirm(true))} data-testid="user-passkeys-delete">
                  {p.deleteAll}
                </Button>
              ))}
          </>
        )}
      </CardContent>
    </Card>
  );
}
