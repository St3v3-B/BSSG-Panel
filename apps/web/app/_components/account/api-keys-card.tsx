"use client";
import { BookOpen, KeyRound, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ALL_PERMISSIONS, type ApiKey, type Permission } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { PermissionPicker } from "@/app/_components/permission-picker";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

/** Rechten van een alleen-lezen-sleutel. */
export const READ_ONLY: Permission[] = ["console.read", "files.read"];
const EXPIRY_DAYS = [0, 30, 90, 365] as const;

export function ApiKeysCard() {
  const t = useT();
  const k = t.devaccess.apiKeys;
  const utils = trpc.useUtils();
  const list = trpc.account.apiKeys.useQuery();
  const revoke = trpc.account.revokeApiKey.useMutation({ onSuccess: () => utils.account.apiKeys.invalidate() });
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<string | null>(null);

  return (
    <Card data-testid="api-keys-card" id="api-keys" className="scroll-mt-20">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="size-5 text-muted-foreground" /> {k.title}
          </CardTitle>
          <Button asChild variant="ghost" size="sm">
            <Link href="/developers">
              <BookOpen /> {k.docs}
            </Link>
          </Button>
        </div>
        <CardDescription>{k.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {created && (
          <Alert className="border-success/40 bg-success/10" data-testid="api-key-created">
            <KeyRound />
            <div className="min-w-0 space-y-2">
              <AlertTitle>{k.createdTitle}</AlertTitle>
              <AlertDescription>{k.createdText}</AlertDescription>
              <div className="flex items-center gap-1 rounded-md border border-border bg-background px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-sm" data-testid="api-key-value">
                  {created}
                </code>
                <CopyButton value={created} label={k.title} />
              </div>
              <Button size="sm" variant="outline" onClick={() => setCreated(null)}>
                {k.done}
              </Button>
            </div>
          </Alert>
        )}
        {list.error ? (
          <QueryError error={list.error} />
        ) : !list.data ? (
          <Skeleton className="h-16 rounded-lg" />
        ) : list.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{k.empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {list.data.map((key) => (
              <KeyRow key={key.id} apiKey={key} onRevoke={() => window.confirm(k.revokeConfirm(key.name)) && revoke.mutate({ id: key.id })} busy={revoke.isPending} />
            ))}
          </ul>
        )}
        {revoke.error && <p className="text-sm text-destructive">{errorText(revoke.error)}</p>}
        {creating ? (
          <CreateKey
            onCancel={() => setCreating(false)}
            onCreated={(key) => {
              setCreated(key);
              setCreating(false);
              void utils.account.apiKeys.invalidate();
            }}
          />
        ) : (
          <Button variant="outline" onClick={() => setCreating(true)} data-testid="api-key-new">
            <Plus /> {k.create}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function KeyRow({ apiKey, onRevoke, busy }: { apiKey: ApiKey; onRevoke: () => void; busy: boolean }) {
  const t = useT();
  const k = t.devaccess.apiKeys;
  const expired = !!apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now();
  const all = ALL_PERMISSIONS.every((p) => apiKey.permissions.includes(p));
  return (
    <li className="flex flex-wrap items-start gap-3 p-3" data-testid="api-key-row">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="break-all">{apiKey.name}</span>
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">{apiKey.prefix}…</code>
          {expired && <Badge variant="destructive">{k.expired}</Badge>}
        </div>
        <div className="flex flex-wrap gap-1">
          {apiKey.permissions.length === 0 ? (
            <span className="text-xs text-muted-foreground">{k.noScopes}</span>
          ) : all ? (
            <Badge variant="secondary">{k.everything}</Badge>
          ) : (
            apiKey.permissions.map((p) => (
              <Badge key={p} variant="secondary" className="font-normal">
                {t.permissions[p].label}
              </Badge>
            ))
          )}
        </div>
        <div className="text-xs text-muted-foreground">
          {apiKey.serverUuids.length ? k.serverCount(apiKey.serverUuids.length) : k.allServers} · {apiKey.lastUsedAt ? k.lastUsed(formatDate(apiKey.lastUsedAt)) : k.neverUsed}
          {apiKey.expiresAt && !expired && <> · {k.expiresAt(formatDate(apiKey.expiresAt))}</>}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onRevoke} disabled={busy} data-testid="api-key-revoke">
        <Trash2 /> {k.revoke}
      </Button>
    </li>
  );
}

function CreateKey({ onCancel, onCreated }: { onCancel: () => void; onCreated: (key: string) => void }) {
  const t = useT();
  const k = t.devaccess.apiKeys;
  const servers = trpc.servers.list.useQuery();
  const create = trpc.account.createApiKey.useMutation({ onSuccess: (r) => onCreated(r.key) });
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<Permission[]>(READ_ONLY);
  const [limit, setLimit] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [days, setDays] = useState<number>(0);
  const invalid = !name.trim() || (limit && picked.length === 0);

  return (
    <form
      className="space-y-4 rounded-lg border border-border p-4"
      data-testid="api-key-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        create.mutate({ name: name.trim(), permissions: perms, serverUuids: limit ? picked : [], expiresAt: days ? new Date(Date.now() + days * 86_400_000) : null });
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="api-key-name">{k.name}</Label>
        <Input id="api-key-name" value={name} maxLength={100} placeholder={k.namePlaceholder} onChange={(e) => setName(e.target.value)} autoFocus />
      </div>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>{k.permissions}</Label>
          <div className="flex gap-1">
            <Button type="button" variant="ghost" size="sm" onClick={() => setPerms(READ_ONLY)}>
              {k.readOnly}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setPerms([...ALL_PERMISSIONS])}>
              {k.everything}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{k.permissionsHint}</p>
        <PermissionPicker value={perms} onChange={setPerms} idPrefix="api-key-perm" />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{k.servers}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="api-key-scope" checked={!limit} onChange={() => setLimit(false)} className="accent-primary" /> {k.serversAll}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="api-key-scope" checked={limit} onChange={() => setLimit(true)} className="accent-primary" data-testid="api-key-limit" /> {k.serversSome}
        </label>
        {limit &&
          (servers.data?.length ? (
            <div className="grid max-h-56 gap-1 overflow-y-auto rounded-md border border-border p-2 sm:grid-cols-2">
              {servers.data.map((s) => (
                <label key={s.uuid} className="flex min-w-0 items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-accent">
                  <Checkbox data-testid="api-key-server" checked={picked.includes(s.uuid)} onChange={() => setPicked((p) => (p.includes(s.uuid) ? p.filter((x) => x !== s.uuid) : [...p, s.uuid]))} />
                  <span className="truncate">{s.name}</span>
                  <code className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">{s.shortId}</code>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{k.noServers}</p>
          ))}
        {limit && picked.length === 0 && servers.data?.length ? <p className="text-xs text-muted-foreground">{k.pickServer}</p> : null}
      </fieldset>
      <div className="space-y-2">
        <Label htmlFor="api-key-expiry">{k.expires}</Label>
        <Select id="api-key-expiry" value={String(days)} onChange={(e) => setDays(Number(e.target.value))} className="max-w-56">
          {EXPIRY_DAYS.map((d) => (
            <option key={d} value={d}>
              {d ? k.expiresDays(d) : k.expiresNever}
            </option>
          ))}
        </Select>
      </div>
      {create.error && <p className="text-sm text-destructive">{errorText(create.error)}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={invalid || create.isPending} data-testid="api-key-submit">
          {create.isPending && <Spinner />} {k.submit}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t.common.cancel}
        </Button>
      </div>
    </form>
  );
}
