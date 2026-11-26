"use client";
import { Trash2, UserPlus } from "lucide-react";
import { useState } from "react";
import type { Permission, Subuser } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { PERMISSION_LABEL, PermissionPicker } from "@/app/_components/permission-picker";
import { QueryError } from "@/app/_components/query-error";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName, UserAvatar } from "@/app/_components/user-avatar";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";

const DEFAULT_PERMS: Permission[] = ["console.read", "console.write", "power", "files.read", "files.write"];

export function SubuserManager({ uuid }: { uuid: string }) {
  const list = trpc.subusers.list.useQuery({ uuid });
  return (
    <div className="max-w-4xl space-y-6">
      <InviteCard uuid={uuid} />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Gebruikers met toegang</CardTitle>
          <CardDescription>Jij bent de eigenaar en hebt alle rechten. Beheerders kunnen ook altijd bij de server.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {list.error ? (
            <QueryError error={list.error} />
          ) : !list.data ? (
            <Skeleton className="h-20" />
          ) : list.data.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nog niemand anders heeft toegang.</p>
          ) : (
            list.data.map((s) => <SubuserRow key={s.user.id} uuid={uuid} sub={s} />)
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function InviteCard({ uuid }: { uuid: string }) {
  const utils = trpc.useUtils();
  const [who, setWho] = useState("");
  const [perms, setPerms] = useState<Permission[]>(DEFAULT_PERMS);
  const invite = trpc.subusers.invite.useMutation({
    onSuccess: () => {
      setWho("");
      setPerms(DEFAULT_PERMS);
      void utils.subusers.list.invalidate({ uuid });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Gebruiker toevoegen</CardTitle>
        <CardDescription>
          Vul een Discord-ID in, of de naam van iemand die al eens heeft ingelogd. Een onbekend Discord-ID krijgt een account dat actief wordt bij de
          eerste login.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (who.trim()) invite.mutate({ uuid, who: who.trim(), permissions: perms });
          }}
        >
          <div className="max-w-md space-y-1.5">
            <Label htmlFor="subuser-who">Discord-ID of naam</Label>
            <Input id="subuser-who" value={who} onChange={(e) => setWho(e.target.value)} placeholder="bv. 123456789012345678" />
          </div>
          <PermissionPicker idPrefix="invite" value={perms} onChange={setPerms} />
          {invite.error && <p className="text-sm text-destructive">{errorText(invite.error)}</p>}
          <Button type="submit" disabled={!who.trim() || invite.isPending}>
            {invite.isPending ? <Spinner /> : <UserPlus />} Toevoegen
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SubuserRow({ uuid, sub }: { uuid: string; sub: Subuser }) {
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [perms, setPerms] = useState<Permission[]>(sub.permissions);
  const [confirm, setConfirm] = useState(false);
  const invalidate = () => utils.subusers.list.invalidate({ uuid });
  const update = trpc.subusers.update.useMutation({ onSuccess: () => (setEditing(false), void invalidate()) });
  const remove = trpc.subusers.remove.useMutation({ onSuccess: () => void invalidate() });
  return (
    <div className="space-y-3 rounded-lg border border-border p-3" data-testid="subuser-row">
      <div className="flex flex-wrap items-center gap-3">
        <UserAvatar user={sub.user} className="size-8" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{displayName(sub.user)}</div>
          <div className="text-xs text-muted-foreground">
            {sub.user.name ? "" : "nog niet ingelogd · "}toegevoegd {formatDate(sub.createdAt)}
          </div>
        </div>
        {!editing && (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => (setPerms(sub.permissions), setEditing(true))}>
              Rechten wijzigen
            </Button>
            {confirm ? (
              <>
                <Button size="sm" variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate({ uuid, userId: sub.user.id })}>
                  {remove.isPending && <Spinner />} Echt verwijderen
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                  Annuleren
                </Button>
              </>
            ) : (
              <Button size="icon-sm" variant="ghost" aria-label={`${displayName(sub.user)} verwijderen`} onClick={() => setConfirm(true)}>
                <Trash2 />
              </Button>
            )}
          </div>
        )}
      </div>
      {editing ? (
        <div className="space-y-3">
          <PermissionPicker idPrefix={`sub-${sub.user.id}`} value={perms} onChange={setPerms} disabled={update.isPending} />
          {update.error && <p className="text-sm text-destructive">{errorText(update.error)}</p>}
          <div className="flex gap-2">
            <Button size="sm" disabled={update.isPending} onClick={() => update.mutate({ uuid, userId: sub.user.id, permissions: perms })}>
              {update.isPending && <Spinner />} Opslaan
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Annuleren
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {sub.permissions.length === 0 && <span className="text-xs text-muted-foreground">Geen rechten</span>}
          {sub.permissions.map((p) => (
            <Badge key={p} variant="secondary">
              {PERMISSION_LABEL[p].label}
            </Badge>
          ))}
        </div>
      )}
      {remove.error && <p className="text-sm text-destructive">{errorText(remove.error)}</p>}
    </div>
  );
}
