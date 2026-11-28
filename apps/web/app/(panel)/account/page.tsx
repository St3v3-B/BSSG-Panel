"use client";
import { ShieldCheck, ShieldOff } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { RecoveryCodesCard, RecoveryCodesList } from "@/app/_components/account/recovery-codes";
import { SessionsCard } from "@/app/_components/account/sessions-card";
import { ApiKeysCard } from "@/app/_components/account/api-keys-card";
import { PasswordLoginCard } from "@/app/_components/account/password-login-card";
import { AccountWebhookCard } from "@/app/_components/notifications/webhook-card";
import { NotificationSettingsCards } from "@/app/_components/notifications/notification-center";
import { CopyButton } from "@/app/_components/copy-button";
import { PageHeader } from "@/app/_components/page-header";
import { QueryError } from "@/app/_components/query-error";
import { isTotpCode, TotpCodeInput } from "@/app/_components/totp-code-input";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName, UserAvatar } from "@/app/_components/user-avatar";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

export default function AccountPage() {
  const t = useT();
  useDocumentTitle(t.account.title);
  const account = trpc.account.get.useQuery();
  if (account.error) return <QueryError error={account.error} />;
  if (!account.data) return <Skeleton className="h-64 rounded-xl" />;
  const me = account.data;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t.account.title} description={t.account.description} />
      <div className="space-y-6">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-4 p-5">
            <UserAvatar user={me.user} className="size-14 text-lg" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-semibold">{displayName(me.user)}</div>
              <div className="flex flex-wrap items-center gap-x-1 text-sm text-muted-foreground">
                {t.account.discordId} <code className="font-mono">{me.user.discordId}</code>
                <CopyButton value={me.user.discordId} label={t.account.copyDiscordId} />
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {me.isOwner ? <Badge variant="warning">{t.nav.roleOwner}</Badge> : me.isAdmin ? <Badge variant="warning">{t.nav.roleAdmin}</Badge> : <Badge variant="secondary">{t.nav.roleUser}</Badge>}
            </div>
          </CardContent>
        </Card>
        <TotpCard enabled={me.totpEnabled} isAdmin={me.isAdmin} />
        {!me.isEmergency && <PasswordLoginCard totpEnabled={me.totpEnabled} />}
        <SessionsCard />
        <ApiKeysCard />
        <NotificationSettingsCards isAdmin={me.isAdmin} />
        <AccountWebhookCard />
      </div>
    </div>
  );
}

function TotpCard({ enabled: serverEnabled, isAdmin }: { enabled: boolean; isAdmin: boolean }) {
  const t = useT();
  const [done, setDone] = useState<null | "enabled" | "disabled">(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  // Na een geslaagde mutatie geldt de bevestiging van de server, ook voordat account.get opnieuw geladen is.
  const enabled = done ? done === "enabled" : serverEnabled;
  return (
    <Card data-testid="totp-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {enabled ? <ShieldCheck className="size-5 text-success" /> : <ShieldOff className="size-5 text-muted-foreground" />}
            {t.account.totpTitle}
          </CardTitle>
          <Badge variant={enabled ? "success" : "secondary"}>{enabled ? t.account.on : t.account.off}</Badge>
        </div>
        <CardDescription>
          {t.account.totpText}
          {isAdmin && t.account.totpAdmin}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {done === "enabled" && (
          <Alert className="mb-4 border-success/40 bg-success/10 text-success">
            <ShieldCheck />
            <div>
              <AlertTitle>{t.account.enabledTitle}</AlertTitle>
              <AlertDescription>{t.account.enabledText}</AlertDescription>
            </div>
          </Alert>
        )}
        {done === "disabled" && (
          <Alert className="mb-4">
            <ShieldOff />
            <div>
              <AlertTitle>{t.account.disabledTitle}</AlertTitle>
            </div>
          </Alert>
        )}
        {codes && <RecoveryCodesList codes={codes} onDone={() => setCodes(null)} />}
        {enabled ? (
          <>
            {!codes && <DisableTotp onDone={() => setDone("disabled")} />}
            {!codes && <RecoveryCodesCard />}
          </>
        ) : (
          <EnableTotp
            onDone={(c) => {
              setDone("enabled");
              setCodes(c);
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function EnableTotp({ onDone }: { onDone: (codes: string[]) => void }) {
  const utils = trpc.useUtils();
  const t = useT();
  const setup = trpc.account.totpSetup.useMutation();
  const enable = trpc.account.totpEnable.useMutation({
    onSuccess: async (r) => {
      onDone(r.recoveryCodes);
      setup.reset();
      setCode("");
      await Promise.all([utils.account.get.invalidate(), utils.auth.me.invalidate()]);
    },
  });
  const [code, setCode] = useState("");
  const [qr, setQr] = useState<string | null>(null);
  const otpauthUrl = setup.data?.otpauthUrl;

  useEffect(() => {
    if (!otpauthUrl) return setQr(null);
    let cancelled = false;
    QRCode.toDataURL(otpauthUrl, { margin: 1, width: 200, color: { dark: "#000000", light: "#ffffff" } })
      .then((url) => !cancelled && setQr(url))
      .catch(() => !cancelled && setQr(null));
    return () => {
      cancelled = true;
    };
  }, [otpauthUrl]);

  if (!setup.data) {
    return (
      <div className="space-y-3">
        {setup.error && <p className="text-sm text-destructive">{errorText(setup.error)}</p>}
        <Button onClick={() => setup.mutate()} disabled={setup.isPending} data-testid="totp-setup">
          {setup.isPending && <Spinner />} {t.account.enable}
        </Button>
      </div>
    );
  }

  return (
    <form
      className="grid gap-6 sm:grid-cols-[auto_1fr]"
      onSubmit={(e) => {
        e.preventDefault();
        if (isTotpCode(code)) enable.mutate({ code });
      }}
    >
      <div className="mx-auto size-[200px] overflow-hidden rounded-lg bg-white p-0" data-testid="totp-qr">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {qr ? <img src={qr} alt={t.account.qrAlt} width={200} height={200} /> : <Skeleton className="size-full bg-zinc-200" />}
      </div>
      <div className="space-y-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>{t.account.step1}</li>
          <li>{t.account.step2}</li>
          <li>{t.account.step3}</li>
        </ol>
        <div className="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-3 py-2">
          <code className="flex-1 break-all font-mono text-sm" data-testid="totp-secret">
            {setup.data.secret.replace(/(.{4})/g, "$1 ").trim()}
          </code>
          <CopyButton value={setup.data.secret} label={t.account.copyKey} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="totp-enable-code">{t.account.appCode}</Label>
          <TotpCodeInput id="totp-enable-code" value={code} onChange={setCode} disabled={enable.isPending} invalid={!!enable.error} className="max-w-48" />
          {enable.error && <p className="text-sm text-destructive">{errorText(enable.error)}</p>}
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={!isTotpCode(code) || enable.isPending}>
            {enable.isPending && <Spinner />} {t.account.confirmEnable}
          </Button>
          <Button variant="ghost" onClick={() => setup.reset()}>
            {t.common.cancel}
          </Button>
        </div>
      </div>
    </form>
  );
}

function DisableTotp({ onDone }: { onDone: () => void }) {
  const utils = trpc.useUtils();
  const t = useT();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const disable = trpc.account.totpDisable.useMutation({
    onSuccess: async () => {
      onDone();
      setOpen(false);
      setCode("");
      await Promise.all([utils.account.get.invalidate(), utils.auth.me.invalidate()]);
    },
  });
  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)} data-testid="totp-disable-open">
        {t.account.disable}
      </Button>
    );
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (isTotpCode(code)) disable.mutate({ code });
      }}
    >
      <Alert variant="warning">
        <div>
          <AlertTitle>{t.account.sure}</AlertTitle>
          <AlertDescription>{t.account.sureText}</AlertDescription>
        </div>
      </Alert>
      <Label htmlFor="totp-disable-code">{t.account.currentCode}</Label>
      <TotpCodeInput id="totp-disable-code" value={code} onChange={setCode} autoFocus disabled={disable.isPending} invalid={!!disable.error} className="max-w-48" />
      {disable.error && <p className="text-sm text-destructive">{errorText(disable.error)}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="destructive" disabled={!isTotpCode(code) || disable.isPending}>
          {disable.isPending && <Spinner />} {t.account.disable}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          {t.common.cancel}
        </Button>
      </div>
    </form>
  );
}
