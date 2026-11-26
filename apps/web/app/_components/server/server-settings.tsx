"use client";
import { RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ServerDetail } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { variableError } from "@/app/_components/create-server-form";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

/** Naam wijzigen (servers.rename). Alleen eigenaar/admin. */
export function RenameCard({ server }: { server: ServerDetail }) {
  const utils = trpc.useUtils();
  const t = useT();
  const [name, setName] = useState(server.name);
  const rename = trpc.servers.rename.useMutation({
    onSuccess: () => Promise.all([utils.servers.get.invalidate({ uuid: server.uuid }), utils.servers.list.invalidate()]),
  });
  const err = !name.trim() ? t.settings.nameRequired : name.trim().length > 100 ? t.settings.nameMax : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.settings.nameTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!err) rename.mutate({ uuid: server.uuid, name: name.trim() });
          }}
        >
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor="server-name" className="sr-only">
              {t.settings.nameLabel}
            </Label>
            <Input id="server-name" value={name} onChange={(e) => (setName(e.target.value), rename.reset())} aria-invalid={!!err || undefined} />
            {err && <p className="text-xs text-destructive">{err}</p>}
            {rename.error && <p className="text-sm text-destructive">{errorText(rename.error)}</p>}
            {rename.isSuccess && (
              <p className="text-sm text-success" role="status">
                {t.settings.nameSaved}
              </p>
            )}
          </div>
          <Button type="submit" disabled={!!err || name.trim() === server.name || rename.isPending}>
            {rename.isPending && <Spinner />} {t.common.save}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Variabelen die de gebruiker mag aanpassen (servers.updateVariables); effect bij de volgende start. */
export function VariablesCard({ server }: { server: ServerDetail }) {
  const utils = trpc.useUtils();
  const t = useT();
  const editable = server.variables.filter((v) => v.userEditable);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((v) => [v.key, v.value])));
  const update = trpc.servers.updateVariables.useMutation({ onSuccess: () => utils.servers.get.invalidate({ uuid: server.uuid }) });
  if (editable.length === 0) return null;
  const errors = Object.fromEntries(editable.map((v) => [v.key, variableError(values[v.key] ?? "", v.pattern)]));
  const invalid = Object.values(errors).some(Boolean);
  const changed = editable.filter((v) => values[v.key] !== v.value);
  return (
    <Card data-testid="variables-card">
      <CardHeader>
        <CardTitle className="text-base">{t.settings.varsTitle}</CardTitle>
        <CardDescription>{t.settings.varsText}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!invalid && changed.length) update.mutate({ uuid: server.uuid, variables: Object.fromEntries(changed.map((v) => [v.key, values[v.key] ?? ""])) });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {editable.map((v) => (
              <div key={v.key} className="space-y-1.5">
                <Label htmlFor={`var-${v.key}`}>{v.name}</Label>
                <Input
                  id={`var-${v.key}`}
                  value={values[v.key] ?? ""}
                  placeholder={v.default}
                  onChange={(e) => (setValues((c) => ({ ...c, [v.key]: e.target.value })), update.reset())}
                  aria-invalid={!!errors[v.key] || undefined}
                />
                {errors[v.key] ? (
                  <p className="text-xs text-destructive">{errors[v.key]}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    <code className="font-mono">{v.key}</code>
                    {v.description && <> · {v.description}</>} · {t.settings.varDefault} <code className="font-mono">{v.default}</code>
                  </p>
                )}
              </div>
            ))}
          </div>
          {update.error && <p className="text-sm text-destructive">{errorText(update.error)}</p>}
          {update.isSuccess && (
            <p className="text-sm text-success" role="status">
              {t.settings.varsSaved}
            </p>
          )}
          <Button type="submit" disabled={invalid || changed.length === 0 || update.isPending}>
            {update.isPending && <Spinner />} {t.settings.varsSave}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/** Herinstalleren (servers.reinstall) met bevestiging; daarna naar Logs/Console om de installatie te volgen. */
export function ReinstallCard({ server, onDone }: { server: ServerDetail; onDone?: () => void }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const t = useT();
  const [confirm, setConfirm] = useState(false);
  const reinstall = trpc.servers.reinstall.useMutation({
    onSuccess: async () => {
      setConfirm(false);
      await Promise.all([utils.servers.get.invalidate({ uuid: server.uuid }), utils.servers.list.invalidate()]);
      if (onDone) onDone();
      else router.push(`/servers/${server.uuid}`);
    },
  });
  const web = server.type === "web";
  return (
    <Card data-testid="reinstall-card">
      <CardHeader>
        <CardTitle className="text-base">{t.settings.reinstallTitle}</CardTitle>
        <CardDescription>{t.settings.reinstallText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {confirm ? (
          <div role="alertdialog" aria-labelledby="reinstall-title" aria-describedby="reinstall-desc" className="space-y-3">
            <Alert variant="warning">
              <div>
                <AlertTitle id="reinstall-title">{t.settings.reinstallConfirmTitle(server.name)}</AlertTitle>
                <AlertDescription id="reinstall-desc">
                  <p>{t.settings.reinstallConfirmText(web)}</p>
                </AlertDescription>
              </div>
            </Alert>
            {reinstall.error && <p className="text-sm text-destructive">{errorText(reinstall.error)}</p>}
            <div className="flex gap-2">
              <Button variant="destructive" onClick={() => reinstall.mutate({ uuid: server.uuid })} disabled={reinstall.isPending}>
                {reinstall.isPending ? <Spinner /> : <RotateCcw />} {t.settings.reinstallYes}
              </Button>
              <Button variant="ghost" onClick={() => (setConfirm(false), reinstall.reset())}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="outline" onClick={() => setConfirm(true)}>
            <RotateCcw /> {t.settings.reinstall}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
