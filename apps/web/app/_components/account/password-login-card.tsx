"use client";
import { CircleAlert, KeyRound, UserRound } from "lucide-react";
import { useState } from "react";
import { LOGIN_PASSWORD_MIN, LoginPassword, LoginUsername } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { isTotpCode, TotpCodeInput } from "@/app/_components/totp-code-input";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

/** Backup-login (gebruikersnaam + wachtwoord) op de accountpagina. Niet voor het noodaccount. */
export function PasswordLoginCard({ totpEnabled }: { totpEnabled: boolean }) {
  const t = useT();
  const p = t.account.passwordLogin;
  const status = trpc.account.passwordLogin.useQuery();
  const [mode, setMode] = useState<null | "edit" | "disable">(null);
  const [notice, setNotice] = useState<null | "saved" | "disabled">(null);
  const s = status.data;

  return (
    <Card data-testid="password-login-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserRound className={s?.enabled ? "size-5 text-success" : "size-5 text-muted-foreground"} />
            {p.title}
          </CardTitle>
          {s && <Badge variant={s.enabled ? "success" : "secondary"}>{s.enabled && s.username ? p.onAs(s.username) : t.account.off}</Badge>}
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
            {notice === "saved" && s.enabled && s.username && (
              <Alert className="border-success/40 bg-success/10 text-success" data-testid="password-login-saved">
                <KeyRound />
                <div>
                  <AlertTitle>{p.savedTitle}</AlertTitle>
                  <AlertDescription>{p.savedText(s.username)}</AlertDescription>
                </div>
              </Alert>
            )}
            {notice === "disabled" && !s.enabled && (
              <Alert data-testid="password-login-disabled">
                <UserRound />
                <div>
                  <AlertTitle>{p.disabledTitle}</AlertTitle>
                </div>
              </Alert>
            )}
            {s.enabled && s.setByAdmin && (
              <Alert variant="warning" data-testid="password-login-admin">
                <CircleAlert />
                <div>
                  <AlertTitle>{p.setByAdminTitle}</AlertTitle>
                  <AlertDescription>{p.setByAdminText}</AlertDescription>
                </div>
              </Alert>
            )}
            {s.enabled && s.updatedAt && <p className="text-sm text-muted-foreground">{p.updated(formatDate(s.updatedAt))}</p>}

            {mode === "edit" ? (
              <PasswordLoginForm
                initialUsername={s.username ?? ""}
                totpEnabled={totpEnabled}
                onCancel={() => setMode(null)}
                onDone={() => {
                  setMode(null);
                  setNotice("saved");
                }}
              />
            ) : mode === "disable" ? (
              <DisablePasswordLogin
                onCancel={() => setMode(null)}
                onDone={() => {
                  setMode(null);
                  setNotice("disabled");
                }}
              />
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button variant={s.enabled ? "outline" : "default"} onClick={() => (setMode("edit"), setNotice(null))} data-testid="password-login-edit">
                  {s.enabled ? p.change : p.enable}
                </Button>
                {s.enabled && (
                  <Button variant="outline" className="text-destructive" onClick={() => (setMode("disable"), setNotice(null))} data-testid="password-login-disable-open">
                    {p.disable}
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function PasswordLoginForm({ initialUsername, totpEnabled, onCancel, onDone }: { initialUsername: string; totpEnabled: boolean; onCancel: () => void; onDone: () => void }) {
  const t = useT();
  const p = t.account.passwordLogin;
  const utils = trpc.useUtils();
  const [username, setUsername] = useState(initialUsername);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [code, setCode] = useState("");
  const [touched, setTouched] = useState(false);
  const save = trpc.account.setPasswordLogin.useMutation({
    onSuccess: (r) => {
      utils.account.passwordLogin.setData(undefined, r);
      onDone();
    },
    onError: () => setCode(""),
  });
  const usernameOk = LoginUsername.safeParse(username).success;
  const passwordOk = LoginPassword.safeParse(password).success;
  const same = password === repeat;
  const codeOk = !totpEnabled || isTotpCode(code);
  const valid = usernameOk && passwordOk && same && codeOk;
  const problem = !touched ? null : !usernameOk ? p.invalidUsername : !passwordOk ? p.tooShort(LOGIN_PASSWORD_MIN) : !same ? p.mismatch : null;

  return (
    <form
      className="space-y-4"
      data-testid="password-login-form"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (valid) save.mutate({ username: username.trim().toLowerCase(), password, ...(totpEnabled ? { code } : {}) });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="pwlogin-username">{p.username}</Label>
          <Input
            id="pwlogin-username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value.toLowerCase())}
            onBlur={() => username && setTouched(true)}
            aria-invalid={(touched && !usernameOk) || undefined}
            disabled={save.isPending}
            className="font-mono sm:max-w-xs"
          />
          <p className="text-xs text-muted-foreground">{p.usernameHint}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pwlogin-password">{p.password}</Label>
          <Input id="pwlogin-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} aria-invalid={(touched && !passwordOk) || undefined} disabled={save.isPending} />
          <p className="text-xs text-muted-foreground">{p.passwordHint(LOGIN_PASSWORD_MIN)}</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="pwlogin-repeat">{p.repeat}</Label>
          <Input id="pwlogin-repeat" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} onBlur={() => repeat && setTouched(true)} aria-invalid={(touched && !same) || undefined} disabled={save.isPending} />
        </div>
      </div>
      {totpEnabled && (
        <div className="space-y-2">
          <Label htmlFor="pwlogin-code">{p.code}</Label>
          <TotpCodeInput id="pwlogin-code" value={code} onChange={setCode} disabled={save.isPending} invalid={!!save.error} className="max-w-48" />
        </div>
      )}
      {problem && (
        <p className="text-sm text-destructive" data-testid="password-login-problem">
          {problem}
        </p>
      )}
      {save.error && <p className="text-sm text-destructive">{errorText(save.error)}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={save.isPending || !codeOk || !username || !password || !repeat}>
          {save.isPending && <Spinner />} {p.save}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t.common.cancel}
        </Button>
      </div>
    </form>
  );
}

function DisablePasswordLogin({ onCancel, onDone }: { onCancel: () => void; onDone: () => void }) {
  const t = useT();
  const p = t.account.passwordLogin;
  const utils = trpc.useUtils();
  const disable = trpc.account.disablePasswordLogin.useMutation({
    onSuccess: (r) => {
      utils.account.passwordLogin.setData(undefined, r);
      onDone();
    },
  });
  return (
    <div className="space-y-3" data-testid="password-login-disable">
      <Alert variant="warning">
        <CircleAlert />
        <div>
          <AlertTitle>{p.disableSure}</AlertTitle>
          <AlertDescription>{p.disableSureText}</AlertDescription>
        </div>
      </Alert>
      {disable.error && <p className="text-sm text-destructive">{errorText(disable.error)}</p>}
      <div className="flex gap-2">
        <Button variant="destructive" disabled={disable.isPending} onClick={() => disable.mutate()} data-testid="password-login-disable-confirm">
          {disable.isPending && <Spinner />} {p.disable}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          {t.common.cancel}
        </Button>
      </div>
    </div>
  );
}
