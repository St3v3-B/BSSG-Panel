"use client";
import { Database as DbIcon, Eye, EyeOff, ExternalLink, KeyRound, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { Database } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

export const DB_NAME_RE = /^[a-zA-Z0-9_]{1,48}$/;

export function DatabaseManager({ uuid }: { uuid: string }) {
  const list = trpc.databases.list.useQuery({ uuid });
  const t = useT();
  return (
    <div className="max-w-4xl space-y-6" data-testid="database-manager">
      <CreateDatabase uuid={uuid} />
      {list.error ? (
        <QueryError error={list.error} />
      ) : !list.data ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : list.data.length === 0 ? (
        <Card className="grid min-h-32 place-items-center p-6 text-sm text-muted-foreground">{t.databases.empty}</Card>
      ) : (
        list.data.map((d) => <DatabaseCard key={d.id} uuid={uuid} db={d} />)
      )}
    </div>
  );
}

function CreateDatabase({ uuid }: { uuid: string }) {
  const utils = trpc.useUtils();
  const t = useT();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const create = trpc.databases.create.useMutation({
    onSuccess: () => {
      setName("");
      setTouched(false);
      void utils.databases.list.invalidate({ uuid });
    },
  });
  const err = DB_NAME_RE.test(name) ? null : t.databases.nameError;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.databases.createTitle}</CardTitle>
        <CardDescription>{t.databases.createText}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!err) create.mutate({ uuid, name });
          }}
        >
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor="db-name" className="sr-only">
              {t.databases.name}
            </Label>
            <Input id="db-name" placeholder={t.databases.placeholder} value={name} onChange={(e) => setName(e.target.value)} aria-invalid={(touched && !!err) || undefined} />
            {touched && err && <p className="text-xs text-destructive">{err}</p>}
            {create.error && <p className="text-sm text-destructive">{errorText(create.error)}</p>}
          </div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? <Spinner /> : <Plus />} {t.common.create}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [show, setShow] = useState(false);
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <code className="block truncate font-mono text-sm">{secret && !show ? "••••••••••••" : value}</code>
      </div>
      <div className="flex shrink-0">
        {secret && (
          <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" aria-label={show ? t.common.hide : t.common.show} onClick={() => setShow((s) => !s)}>
            {show ? <EyeOff /> : <Eye />}
          </Button>
        )}
        <CopyButton value={value} label={t.common.copyX(label)} />
      </div>
    </div>
  );
}

function DatabaseCard({ uuid, db }: { uuid: string; db: Database }) {
  const utils = trpc.useUtils();
  const t = useT();
  const [confirm, setConfirm] = useState<null | "reset" | "delete">(null);
  const reset = trpc.databases.resetPassword.useMutation({
    onSuccess: (next) => {
      setConfirm(null);
      utils.databases.list.setData({ uuid }, (cur) => cur?.map((d) => (d.id === next.id ? next : d)));
    },
  });
  const del = trpc.databases.delete.useMutation({ onSuccess: () => void utils.databases.list.invalidate({ uuid }) });
  return (
    <Card data-testid="database-card">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <DbIcon className="size-4 text-muted-foreground" /> {db.name}
          </CardTitle>
          {db.adminerUrl && (
            <Button asChild size="sm" variant="outline">
              <a href={db.adminerUrl} target="_blank" rel="noreferrer">
                <ExternalLink /> Adminer
              </a>
            </Button>
          )}
        </div>
        <CardDescription>{t.databases.on(db.hostName)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t.databases.host} value={db.host} />
          <Field label={t.databases.port} value={String(db.port)} />
          <Field label={t.databases.database} value={db.name} />
          <Field label={t.databases.user} value={db.username} />
          <Field label={t.databases.password} value={db.password} secret />
          <Field label={t.databases.url} value={`mysql://${db.username}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${db.name}`} secret />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {confirm === "reset" ? (
            <>
              <span className="text-sm text-warning">{t.databases.resetWarn}</span>
              <Button size="sm" onClick={() => reset.mutate({ id: db.id })} disabled={reset.isPending}>
                {reset.isPending && <Spinner />} {t.databases.newPassword}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                {t.common.cancel}
              </Button>
            </>
          ) : confirm === "delete" ? (
            <>
              <span className="text-sm text-destructive">{t.databases.deleteWarn}</span>
              <Button size="sm" variant="destructive" onClick={() => del.mutate({ id: db.id })} disabled={del.isPending}>
                {del.isPending && <Spinner />} {t.common.delete}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                {t.common.cancel}
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setConfirm("reset")}>
                <KeyRound /> {t.databases.resetPassword}
              </Button>
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirm("delete")}>
                <Trash2 /> {t.common.delete}
              </Button>
            </>
          )}
        </div>
        {[reset.error, del.error].filter(Boolean).map((e, i) => (
          <p key={i} className="text-sm text-destructive">
            {errorText(e)}
          </p>
        ))}
      </CardContent>
    </Card>
  );
}
