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

export const DB_NAME_RE = /^[a-zA-Z0-9_]{1,48}$/;

export function DatabaseManager({ uuid }: { uuid: string }) {
  const list = trpc.databases.list.useQuery({ uuid });
  return (
    <div className="max-w-4xl space-y-6" data-testid="database-manager">
      <CreateDatabase uuid={uuid} />
      {list.error ? (
        <QueryError error={list.error} />
      ) : !list.data ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : list.data.length === 0 ? (
        <Card className="grid min-h-32 place-items-center p-6 text-sm text-muted-foreground">Nog geen databases.</Card>
      ) : (
        list.data.map((d) => <DatabaseCard key={d.id} uuid={uuid} db={d} />)
      )}
    </div>
  );
}

function CreateDatabase({ uuid }: { uuid: string }) {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  const create = trpc.databases.create.useMutation({
    onSuccess: () => {
      setName("");
      setTouched(false);
      void utils.databases.list.invalidate({ uuid });
    },
  });
  const err = DB_NAME_RE.test(name) ? null : "Alleen letters, cijfers en _ (max. 48 tekens)";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Database aanmaken</CardTitle>
        <CardDescription>Een MariaDB-database met een eigen gebruiker. Het panel zet er automatisch een voorvoegsel voor.</CardDescription>
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
              Naam
            </Label>
            <Input id="db-name" placeholder="bv. wordpress" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={(touched && !!err) || undefined} />
            {touched && err && <p className="text-xs text-destructive">{err}</p>}
            {create.error && <p className="text-sm text-destructive">{errorText(create.error)}</p>}
          </div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? <Spinner /> : <Plus />} Aanmaken
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [show, setShow] = useState(false);
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <code className="block truncate font-mono text-sm">{secret && !show ? "••••••••••••" : value}</code>
      </div>
      <div className="flex shrink-0">
        {secret && (
          <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" aria-label={show ? "Verbergen" : "Tonen"} onClick={() => setShow((s) => !s)}>
            {show ? <EyeOff /> : <Eye />}
          </Button>
        )}
        <CopyButton value={value} label={`${label} kopiëren`} />
      </div>
    </div>
  );
}

function DatabaseCard({ uuid, db }: { uuid: string; db: Database }) {
  const utils = trpc.useUtils();
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
        <CardDescription>Op {db.hostName}. Vanuit je site verbind je met host en poort hieronder.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Host" value={db.host} />
          <Field label="Poort" value={String(db.port)} />
          <Field label="Database" value={db.name} />
          <Field label="Gebruiker" value={db.username} />
          <Field label="Wachtwoord" value={db.password} secret />
          <Field label="Verbinding (URL)" value={`mysql://${db.username}:${encodeURIComponent(db.password)}@${db.host}:${db.port}/${db.name}`} secret />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {confirm === "reset" ? (
            <>
              <span className="text-sm text-warning">Het oude wachtwoord werkt daarna niet meer; pas je site-config aan.</span>
              <Button size="sm" onClick={() => reset.mutate({ id: db.id })} disabled={reset.isPending}>
                {reset.isPending && <Spinner />} Nieuw wachtwoord
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                Annuleren
              </Button>
            </>
          ) : confirm === "delete" ? (
            <>
              <span className="text-sm text-destructive">Database en alle data definitief verwijderen?</span>
              <Button size="sm" variant="destructive" onClick={() => del.mutate({ id: db.id })} disabled={del.isPending}>
                {del.isPending && <Spinner />} Verwijderen
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                Annuleren
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="outline" onClick={() => setConfirm("reset")}>
                <KeyRound /> Wachtwoord resetten
              </Button>
              <Button size="sm" variant="outline" className="text-destructive" onClick={() => setConfirm("delete")}>
                <Trash2 /> Verwijderen
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
