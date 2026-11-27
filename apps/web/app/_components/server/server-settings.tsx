"use client";
import { Moon, RotateCcw, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ServerDetail } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { variableError } from "@/app/_components/create-server-form";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";
import { isDowngrade } from "@/app/_lib/versions";

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

const VERSION_KEYS = ["MINECRAFT_VERSION", "VELOCITY_VERSION", "BUILD", "LOADER_VERSION"];

/** Dropdown with versions from PaperMC/Fabric; falls back to a text field when the list isn't available. */
function VersionField({ v, value, options, onChange, invalid, unstable }: { v: ServerDetail["variables"][number]; value: string; options: Array<{ id: string; stable: boolean }>; onChange: (x: string) => void; invalid: boolean; unstable: boolean }) {
  const t = useT();
  const ids = options.filter((o) => unstable || o.stable).map((o) => o.id);
  const all = ["latest", ...ids];
  if (value && !all.includes(value)) all.push(value);
  return (
    <Select id={`var-${v.key}`} value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={invalid || undefined}>
      {all.map((id) => (
        <option key={id} value={id}>
          {id === "latest" ? t.versions.latest : id}
        </option>
      ))}
    </Select>
  );
}

/** After a version change: offer to reinstall straight away. */
function ReinstallNow({ server }: { server: ServerDetail }) {
  const t = useT();
  const router = useRouter();
  const utils = trpc.useUtils();
  const reinstall = trpc.servers.reinstall.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.servers.get.invalidate({ uuid: server.uuid }), utils.servers.list.invalidate()]);
      router.push(`/servers/${server.uuid}`);
    },
  });
  return (
    <Alert variant="warning" data-testid="version-changed">
      <div className="space-y-2">
        <AlertTitle>{t.versions.changedTitle}</AlertTitle>
        <AlertDescription>{t.versions.changedText}</AlertDescription>
        {reinstall.error && <p className="text-sm text-destructive">{errorText(reinstall.error)}</p>}
        <Button size="sm" onClick={() => reinstall.mutate({ uuid: server.uuid })} disabled={reinstall.isPending}>
          {reinstall.isPending ? <Spinner /> : <RotateCcw />} {t.versions.reinstallNow}
        </Button>
      </div>
    </Alert>
  );
}

/** Variabelen die de gebruiker mag aanpassen (servers.updateVariables); effect bij de volgende start. */
export function VariablesCard({ server, all = false }: { server: ServerDetail; all?: boolean }) {
  const utils = trpc.useUtils();
  const t = useT();
  // admins (all) zien ook de variabelen die gebruikers niet mogen aanpassen
  const editable = server.variables.filter((v) => all || v.userEditable);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(editable.map((v) => [v.key, v.value])));
  const [unstable, setUnstable] = useState(false);
  const [versionsChanged, setVersionsChanged] = useState(false);
  const update = trpc.servers.updateVariables.useMutation({
    onSuccess: (_r, vars) => {
      setVersionsChanged(Object.keys(vars.variables).some((k) => VERSION_KEYS.includes(k)));
      void utils.servers.get.invalidate({ uuid: server.uuid });
    },
  });
  const pickable = (server.isOwner || all) && editable.some((v) => VERSION_KEYS.includes(v.key));
  const verKey = editable.find((v) => v.key === "MINECRAFT_VERSION" || v.key === "VELOCITY_VERSION")?.key;
  const opts = trpc.content.versionOptions.useQuery(
    { uuid: server.uuid, minecraftVersion: verKey ? values[verKey] : undefined },
    { enabled: pickable, staleTime: 5 * 60_000, retry: false, placeholderData: (prev) => prev },
  );
  if (editable.length === 0) return null;
  const errors = Object.fromEntries(editable.map((v) => [v.key, variableError(values[v.key] ?? "", v.pattern)]));
  const invalid = Object.values(errors).some(Boolean);
  const changed = editable.filter((v) => values[v.key] !== v.value);
  const pk = opts.data?.variables;
  const list = (key: string) =>
    pk && key === pk.version && opts.data!.versions.length ? opts.data!.versions : pk && key === pk.build && opts.data!.builds.length ? opts.data!.builds.map((id) => ({ id, stable: true })) : pk && key === pk.loader && opts.data!.loaderVersions.length ? opts.data!.loaderVersions : null;
  const mainChanged = verKey ? changed.find((v) => v.key === verKey) : undefined;
  const downgrade = mainChanged && isDowngrade(mainChanged.value, values[mainChanged.key] ?? "");
  return (
    <Card data-testid="variables-card">
      <CardHeader>
        <CardTitle className="text-base">{t.settings.varsTitle}</CardTitle>
        <CardDescription>{all ? t.adminServer.varsAllText : t.settings.varsText}</CardDescription>
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
            {editable.map((v) => {
              const options = list(v.key);
              const set = (x: string) => (setValues((c) => ({ ...c, [v.key]: x })), update.reset(), setVersionsChanged(false));
              return (
                <div key={v.key} className="space-y-1.5">
                  <Label htmlFor={`var-${v.key}`}>
                    {v.name}
                    {all && !v.userEditable && <span className="ml-2 text-xs font-normal text-muted-foreground">({t.adminServer.locked})</span>}
                  </Label>
                  {options ? (
                    <VersionField v={v} value={values[v.key] ?? ""} options={options} onChange={set} invalid={!!errors[v.key]} unstable={unstable} />
                  ) : (
                    <Input id={`var-${v.key}`} value={values[v.key] ?? ""} placeholder={v.default} onChange={(e) => set(e.target.value)} aria-invalid={!!errors[v.key] || undefined} />
                  )}
                  {errors[v.key] ? (
                    <p className="text-xs text-destructive">{errors[v.key]}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      <code className="font-mono">{v.key}</code>
                      {v.description && <> · {v.description}</>} · {t.settings.varDefault} <code className="font-mono">{v.default}</code>
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          {pk && opts.data!.versions.length > 0 && opts.data!.versions.some((o) => !o.stable) && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={unstable} onChange={(e) => setUnstable(e.target.checked)} /> {t.versions.showUnstable}
            </label>
          )}
          {downgrade && (
            <Alert variant="warning" data-testid="version-downgrade">
              <TriangleAlert />
              <div>
                <AlertTitle>{t.versions.downgradeTitle}</AlertTitle>
                <AlertDescription>{t.versions.downgradeText}</AlertDescription>
              </div>
            </Alert>
          )}
          {update.error && <p className="text-sm text-destructive">{errorText(update.error)}</p>}
          {update.isSuccess && (
            <p className="text-sm text-success" role="status">
              {t.settings.varsSaved}
            </p>
          )}
          {update.isSuccess && versionsChanged && <ReinstallNow server={server} />}
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

/** Slaapstand (servers.updateSleep); alleen als de template het ondersteunt. Eigenaar of admin. */
export function SleepCard({ server }: { server: ServerDetail }) {
  const utils = trpc.useUtils();
  const t = useT();
  const [enabled, setEnabled] = useState(server.sleep.enabled);
  const [minutes, setMinutes] = useState(String(server.sleep.idleMinutes));
  const save = trpc.servers.updateSleep.useMutation({ onSuccess: () => utils.servers.get.invalidate({ uuid: server.uuid }) });
  if (!server.sleep.supported) return null;
  const m = Number(minutes);
  const valid = Number.isInteger(m) && m >= 1 && m <= 1440;
  const changed = enabled !== server.sleep.enabled || m !== server.sleep.idleMinutes;
  return (
    <Card data-testid="sleep-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Moon className="size-4 text-indigo-300" /> {t.sleep.title}
        </CardTitle>
        <CardDescription>{t.sleep.explain(valid ? m : server.sleep.idleMinutes)}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate({ uuid: server.uuid, enabled, idleMinutes: m });
          }}
        >
          <label className="flex items-center gap-2 text-sm">
            <Checkbox role="switch" checked={enabled} onChange={(e) => (setEnabled(e.target.checked), save.reset())} /> {t.sleep.toggle}
          </label>
          <div className="max-w-48 space-y-1.5">
            <Label htmlFor="sleep-minutes">{t.sleep.minutes}</Label>
            <Input
              id="sleep-minutes"
              type="number"
              min={1}
              max={1440}
              inputMode="numeric"
              value={minutes}
              disabled={!enabled}
              aria-invalid={!valid || undefined}
              onChange={(e) => (setMinutes(e.target.value), save.reset())}
            />
            {!valid && <p className="text-xs text-destructive">{t.sleep.minutesError}</p>}
          </div>
          {save.error && <p className="text-sm text-destructive">{errorText(save.error)}</p>}
          {save.isSuccess && (
            <p className="text-sm text-success" role="status">
              {t.sleep.saved}
            </p>
          )}
          <Button type="submit" disabled={!valid || !changed || save.isPending}>
            {save.isPending && <Spinner />} {t.sleep.save}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
