"use client";
import { useState } from "react";
import type { PhpSettings } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

const TIMEZONES = typeof Intl !== "undefined" && "supportedValuesOf" in Intl ? (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone") : ["Europe/Amsterdam", "UTC"];

/** PHP settings of a PHP website (siteSettings.php / updatePhp). Renders nothing for other sites. */
export function PhpSettingsCard({ uuid }: { uuid: string }) {
  const q = trpc.siteSettings.php.useQuery({ uuid }, { retry: false });
  if (q.error) return null;
  if (!q.data) return <Skeleton className="h-64 rounded-xl" />;
  return <PhpForm key={JSON.stringify(q.data.settings)} uuid={uuid} info={q.data} />;
}

function PhpForm({ uuid, info }: { uuid: string; info: { settings: PhpSettings; defaults: PhpSettings; managed: boolean; ramLimitMb: number; extensions: PhpSettings["disabledExtensions"] } }) {
  const t = useT();
  const p = t.php;
  const utils = trpc.useUtils();
  const [v, setV] = useState<PhpSettings>(info.settings);
  const save = trpc.siteSettings.updatePhp.useMutation({ onSuccess: () => utils.siteSettings.php.invalidate({ uuid }) });
  const num = (k: "memoryLimitMb" | "uploadMaxMb" | "maxExecutionTime" | "maxInputVars", label: string, unit: string, min: number, max: number) => (
    <div className="space-y-1.5">
      <Label htmlFor={`php-${k}`}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input id={`php-${k}`} type="number" inputMode="numeric" min={min} max={max} value={v[k]} onChange={(e) => (setV({ ...v, [k]: Number(e.target.value) }), save.reset())} />
        <span className="text-sm text-muted-foreground">{unit}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {min}–{max}
      </p>
    </div>
  );
  const bounds = {
    memory: v.memoryLimitMb >= 32 && v.memoryLimitMb <= info.ramLimitMb,
    upload: v.uploadMaxMb >= 1 && v.uploadMaxMb <= 4096,
    time: v.maxExecutionTime >= 1 && v.maxExecutionTime <= 300,
    vars: v.maxInputVars >= 100 && v.maxInputVars <= 100000,
    tz: TIMEZONES.includes(v.timezone),
  };
  const valid = Object.values(bounds).every(Boolean) && Number.isInteger(v.memoryLimitMb + v.uploadMaxMb + v.maxExecutionTime + v.maxInputVars);
  const changed = JSON.stringify(v) !== JSON.stringify(info.settings) || !info.managed;
  return (
    <Card data-testid="php-settings-card">
      <CardHeader>
        <CardTitle className="text-base">{p.title}</CardTitle>
        <CardDescription>{p.text}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save.mutate({ uuid, settings: v });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {num("memoryLimitMb", p.memory, "MB", 32, info.ramLimitMb)}
            {num("uploadMaxMb", p.upload, "MB", 1, 4096)}
            {num("maxExecutionTime", p.maxTime, p.seconds, 1, 300)}
            {num("maxInputVars", p.maxVars, "", 100, 100000)}
            <div className="space-y-1.5">
              <Label htmlFor="php-tz">{p.timezone}</Label>
              <Input id="php-tz" list="php-tz-list" value={v.timezone} onChange={(e) => (setV({ ...v, timezone: e.target.value }), save.reset())} aria-invalid={!bounds.tz || undefined} />
              <datalist id="php-tz-list">
                {TIMEZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{p.uploadHint}</p>
          <div className="space-y-2">
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox checked={v.displayErrors} onChange={(e) => setV({ ...v, displayErrors: e.target.checked })} /> {p.displayErrors}
            </Label>
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox checked={v.opcache} onChange={(e) => setV({ ...v, opcache: e.target.checked })} /> {p.opcache}
            </Label>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{p.extensions}</legend>
            <div className="flex flex-wrap gap-4">
              {info.extensions.map((x) => (
                <Label key={x} className="flex items-center gap-2 font-mono font-normal">
                  <Checkbox
                    checked={!v.disabledExtensions.includes(x)}
                    onChange={(e) => setV({ ...v, disabledExtensions: e.target.checked ? v.disabledExtensions.filter((y) => y !== x) : [...v.disabledExtensions, x] })}
                  />{" "}
                  {x}
                </Label>
              ))}
            </div>
            {v.disabledExtensions.includes("mysqli") && <p className="text-xs text-destructive">{p.mysqliWarn}</p>}
          </fieldset>
          {!bounds.memory && <p className="text-sm text-destructive">{p.memoryMax(info.ramLimitMb)}</p>}
          {save.error && (
            <p className="text-sm text-destructive" role="alert">
              {errorText(save.error)}
            </p>
          )}
          {save.isSuccess && (
            <Alert>
              <AlertDescription>{p.saved}</AlertDescription>
            </Alert>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!valid || !changed || save.isPending}>
              {save.isPending && <Spinner />} {p.save}
            </Button>
            <span className="text-xs text-muted-foreground">{info.managed ? p.managed : p.notManaged}</span>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
