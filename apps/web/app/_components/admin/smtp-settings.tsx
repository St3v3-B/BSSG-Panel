"use client";
import { Mail } from "lucide-react";
import { useState } from "react";
import type { SmtpSecurity, SmtpSettings } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_RE = /^[A-Za-z0-9.-]+$|^\[[0-9a-fA-F:.]+\]$/;
const DEFAULT_PORT: Record<SmtpSecurity, number> = { tls: 465, starttls: 587, none: 25 };

/** Admin: SMTP-server, testmail. */
export function SmtpSettingsCard() {
  const q = trpc.admin.smtp.get.useQuery();
  // De melding staat hier: het formulier mount opnieuw met de opgeslagen gegevens (wachtwoordveld leeg).
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  return <SmtpForm key={JSON.stringify(q.data)} data={q.data} msg={msg} setMsg={setMsg} />;
}

type Msg = { ok: boolean; text: string } | null;

function SmtpForm({ data, msg, setMsg }: { data: SmtpSettings; msg: Msg; setMsg: (m: Msg) => void }) {
  const t = useT().notif2;
  const utils = trpc.useUtils();
  const [f, setF] = useState({ host: data.host ?? "", port: String(data.port), security: data.security, username: data.username ?? "", password: "", clearPassword: false, from: data.from ?? "", fromName: data.fromName ?? "" });
  const [to, setTo] = useState("");
  const save = trpc.admin.smtp.set.useMutation({ onSuccess: (d) => utils.admin.smtp.get.setData(undefined, d) });
  const test = trpc.admin.smtp.test.useMutation();
  const port = Number(f.port);
  const valid = HOST_RE.test(f.host.trim()) && Number.isInteger(port) && port >= 1 && port <= 65535 && (EMAIL_RE.test(f.from.trim()) || (!f.from.trim() && EMAIL_RE.test(f.username.trim())));
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => (setMsg(null), setF({ ...f, [k]: e.target.value }));
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };
  return (
    <div className="space-y-6">
      <Card data-testid="smtp-card">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Mail className="size-4 text-muted-foreground" /> {t.smtpTitle}
          </CardTitle>
          <CardDescription>{data.host ? t.smtpText : t.smtpNotSet}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid) return void setMsg({ ok: false, text: t.smtpInvalid });
              void run(
                () =>
                  save.mutateAsync({
                    host: f.host.trim(),
                    port,
                    security: f.security,
                    username: f.username.trim() || null,
                    password: f.clearPassword ? null : f.password ? f.password : undefined,
                    from: f.from.trim() || null,
                    fromName: f.fromName.trim() || null,
                  }),
                t.smtpSaved,
              );
            }}
          >
            <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
              <div className="space-y-1.5">
                <Label htmlFor="smtp-host">{t.smtpHost}</Label>
                <Input id="smtp-host" value={f.host} placeholder="smtp.example.com" spellCheck={false} onChange={set("host")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-port">{t.smtpPort}</Label>
                <Input id="smtp-port" type="number" min={1} max={65535} inputMode="numeric" value={f.port} onChange={set("port")} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="smtp-security">{t.smtpSecurity}</Label>
              <Select
                id="smtp-security"
                value={f.security}
                onChange={(e) => {
                  const sec = e.target.value as SmtpSecurity;
                  // Poort meeveranderen zolang die nog op een standaardwaarde staat.
                  const std = Object.values(DEFAULT_PORT).includes(Number(f.port));
                  setF({ ...f, security: sec, port: std ? String(DEFAULT_PORT[sec]) : f.port });
                }}
              >
                {(["starttls", "tls", "none"] as const).map((s) => (
                  <option key={s} value={s}>
                    {t.smtpSecurityOptions[s]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="smtp-user">{t.smtpUsername}</Label>
                <Input id="smtp-user" value={f.username} autoComplete="off" onChange={set("username")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-pass">{t.smtpPassword}</Label>
                <Input id="smtp-pass" type="password" value={f.password} autoComplete="new-password" placeholder={data.passwordSet ? "••••••••" : ""} disabled={f.clearPassword} onChange={set("password")} />
                {data.passwordSet && (
                  <>
                    <p className="text-xs text-muted-foreground">{t.smtpPasswordKeep}</p>
                    <label className="flex items-center gap-2 text-xs">
                      <Checkbox checked={f.clearPassword} onChange={(e) => setF({ ...f, clearPassword: e.target.checked, password: "" })} /> {t.smtpPasswordClear}
                    </label>
                  </>
                )}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="smtp-from">{t.smtpFrom}</Label>
                <Input id="smtp-from" type="email" value={f.from} placeholder="panel@example.com" onChange={set("from")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="smtp-from-name">{t.smtpFromName}</Label>
                <Input id="smtp-from-name" value={f.fromName} maxLength={100} onChange={set("fromName")} />
                <p className="text-xs text-muted-foreground">{t.smtpFromNameHint}</p>
              </div>
            </div>
            {msg && <p className={cn("text-sm", msg.ok ? "text-success" : "text-destructive")} role="status">{msg.text}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={save.isPending}>
                {save.isPending && <Spinner />} {t.smtpSave}
              </Button>
              {data.host && (
                <Button type="button" variant="ghost" disabled={save.isPending} onClick={() => void run(() => save.mutateAsync({ host: null, port: 587, security: "starttls", username: null, from: null, fromName: null }), t.smtpDisabled)}>
                  {t.smtpDisable}
                </Button>
              )}
            </div>
          </form>
        </CardContent>
      </Card>
      {data.host && (
        <Card>
          <CardContent className="pt-6">
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (EMAIL_RE.test(to.trim())) test.mutate({ to: to.trim() });
              }}
            >
              <div className="min-w-56 flex-1 space-y-1.5">
                <Label htmlFor="smtp-test-to">{t.smtpTestTo}</Label>
                <Input id="smtp-test-to" type="email" value={to} onChange={(e) => (test.reset(), setTo(e.target.value))} />
              </div>
              <Button type="submit" variant="outline" disabled={test.isPending || !EMAIL_RE.test(to.trim())}>
                {test.isPending && <Spinner />} {t.smtpTestSend}
              </Button>
            </form>
            {test.data && <p className={cn("mt-3 text-sm", test.data.ok ? "text-success" : "text-destructive")} role="status">{test.data.ok ? t.smtpTestOk : t.smtpTestFailed(test.data.error ?? "")}</p>}
            {test.error && <p className="mt-3 text-sm text-destructive">{errorText(test.error)}</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
