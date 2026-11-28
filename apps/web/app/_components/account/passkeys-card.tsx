"use client";
import type { Passkey } from "@panel/api";
import { PasskeyName } from "@panel/api/schemas";
import { CircleAlert, Fingerprint, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorInfo, errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { createPasskey, PasskeyCancelled, usePasskeySupport } from "@/app/_lib/passkey";

/** Accountkaart "Passkeys": toevoegen, lijst, hernoemen, verwijderen. Niet voor het noodaccount. */
export function PasskeysCard() {
  const t = useT();
  const p = t.account.passkeys;
  const list = trpc.account.passkeys.list.useQuery();
  const supported = usePasskeySupport();
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<null | "added" | "cancelled">(null);

  return (
    <Card data-testid="passkeys-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Fingerprint className={list.data?.length ? "size-5 text-success" : "size-5 text-muted-foreground"} />
            {p.title}
          </CardTitle>
          {list.data && <Badge variant={list.data.length ? "success" : "secondary"}>{list.data.length ? p.count(list.data.length) : t.account.off}</Badge>}
        </div>
        <CardDescription>{p.text}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {list.error ? (
          <QueryError error={list.error} />
        ) : !list.data ? (
          <Skeleton className="h-10 rounded-lg" />
        ) : (
          <>
            {notice === "added" && (
              <Alert className="border-success/40 bg-success/10 text-success" data-testid="passkey-added">
                <Fingerprint />
                <div>
                  <AlertTitle>{p.addedTitle}</AlertTitle>
                </div>
              </Alert>
            )}
            {notice === "cancelled" && <p className="text-sm text-muted-foreground">{p.cancelled}</p>}
            {list.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">{p.none}</p>
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border" data-testid="passkey-list">
                {list.data.map((k) => (
                  <PasskeyRow key={k.id} passkey={k} />
                ))}
              </ul>
            )}
            {!supported ? (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground" data-testid="passkey-unsupported">
                <CircleAlert className="size-4" /> {p.unsupported}
              </p>
            ) : adding ? (
              <AddPasskey
                onCancel={() => setAdding(false)}
                onDone={(r) => {
                  setAdding(false);
                  setNotice(r);
                }}
              />
            ) : (
              <Button variant={list.data.length ? "outline" : "default"} onClick={() => (setAdding(true), setNotice(null))} data-testid="passkey-add">
                <Plus /> {p.add}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AddPasskey({ onCancel, onDone }: { onCancel: () => void; onDone: (r: "added" | "cancelled") => void }) {
  const t = useT();
  const p = t.account.passkeys;
  const utils = trpc.useUtils();
  const [name, setName] = useState(p.defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = trpc.account.passkeys.registerOptions.useMutation();
  const register = trpc.account.passkeys.register.useMutation();
  const valid = PasskeyName.safeParse(name).success;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = await options.mutateAsync();
      const response = await createPasskey(opts);
      await register.mutateAsync({ name: name.trim(), response });
      await utils.account.passkeys.list.invalidate();
      onDone("added");
    } catch (e) {
      if (e instanceof PasskeyCancelled) return onDone("cancelled");
      setError(errorInfo(e).code ? errorText(e) : t.login.passkey.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-3"
      data-testid="passkey-add-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) void run();
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="passkey-name">{p.name}</Label>
        <Input id="passkey-name" autoFocus maxLength={64} placeholder={p.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} disabled={busy} className="sm:max-w-xs" />
      </div>
      {busy && <p className="text-sm text-muted-foreground">{p.waiting}</p>}
      {error && (
        <p className="text-sm text-destructive" data-testid="passkey-add-error">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!valid || busy} data-testid="passkey-create">
          {busy ? <Spinner /> : <Fingerprint />} {p.create}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t.common.cancel}
        </Button>
      </div>
    </form>
  );
}

function PasskeyRow({ passkey: k }: { passkey: Passkey }) {
  const t = useT();
  const p = t.account.passkeys;
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<null | "rename" | "delete">(null);
  const [name, setName] = useState(k.name);
  const done = async () => {
    setMode(null);
    await utils.account.passkeys.list.invalidate();
  };
  const rename = trpc.account.passkeys.rename.useMutation({ onSuccess: done });
  const del = trpc.account.passkeys.delete.useMutation({ onSuccess: done });
  const error = rename.error ?? del.error;

  return (
    <li className="space-y-2 p-3" data-testid={`passkey-${k.id}`}>
      <div className="flex flex-wrap items-center gap-3">
        <Fingerprint className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{k.name}</span>
            {k.backedUp && <Badge variant="secondary">{p.synced}</Badge>}
          </div>
          <div className="text-xs text-muted-foreground">
            {p.created(formatDate(k.createdAt))} · {k.lastUsedAt ? p.lastUsed(formatDate(k.lastUsedAt)) : p.neverUsed}
          </div>
        </div>
        {mode === null && (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => (rename.reset(), setName(k.name), setMode("rename"))} aria-label={p.rename} data-testid={`passkey-rename-${k.id}`}>
              <Pencil />
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => (del.reset(), setMode("delete"))} aria-label={p.delete} data-testid={`passkey-delete-${k.id}`}>
              <Trash2 />
            </Button>
          </div>
        )}
      </div>
      {mode === "rename" && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (PasskeyName.safeParse(name).success) rename.mutate({ id: k.id, name: name.trim() });
          }}
        >
          <Input aria-label={p.name} autoFocus maxLength={64} value={name} onChange={(e) => setName(e.target.value)} disabled={rename.isPending} className="h-8 sm:max-w-xs" />
          <Button type="submit" size="sm" disabled={!PasskeyName.safeParse(name).success || rename.isPending} data-testid={`passkey-rename-save-${k.id}`}>
            {rename.isPending && <Spinner />} {p.save}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setMode(null)}>
            {t.common.cancel}
          </Button>
        </form>
      )}
      {mode === "delete" && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">{p.deleteSure(k.name)}</span>
          <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate({ id: k.id })} data-testid={`passkey-delete-confirm-${k.id}`}>
            {del.isPending && <Spinner />} {p.delete}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
            {t.common.cancel}
          </Button>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{errorText(error)}</p>}
    </li>
  );
}
