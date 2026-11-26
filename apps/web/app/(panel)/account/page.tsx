"use client";
import { ShieldCheck, ShieldOff } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
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

export default function AccountPage() {
  useDocumentTitle("Account");
  const account = trpc.account.get.useQuery();
  if (account.error) return <QueryError error={account.error} />;
  if (!account.data) return <Skeleton className="h-64 rounded-xl" />;
  const me = account.data;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Account" description="Je gegevens en beveiliging" />
      <div className="space-y-6">
        <Card>
          <CardContent className="flex items-center gap-4 p-5">
            <UserAvatar user={me.user} className="size-14 text-lg" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-lg font-semibold">{displayName(me.user)}</div>
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                Discord-ID <code className="font-mono">{me.user.discordId}</code>
                <CopyButton value={me.user.discordId} label="Discord-ID kopiëren" />
              </div>
            </div>
            <div className="flex flex-col items-end gap-1.5">
              {me.isOwner ? <Badge variant="warning">Eigenaar</Badge> : me.isAdmin ? <Badge variant="warning">Beheerder</Badge> : <Badge variant="secondary">Gebruiker</Badge>}
            </div>
          </CardContent>
        </Card>
        <TotpCard enabled={me.totpEnabled} isAdmin={me.isAdmin} />
      </div>
    </div>
  );
}

function TotpCard({ enabled: serverEnabled, isAdmin }: { enabled: boolean; isAdmin: boolean }) {
  const [done, setDone] = useState<null | "enabled" | "disabled">(null);
  // Na een geslaagde mutatie geldt de bevestiging van de server, ook voordat account.get opnieuw geladen is.
  const enabled = done ? done === "enabled" : serverEnabled;
  return (
    <Card data-testid="totp-card">
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            {enabled ? <ShieldCheck className="size-5 text-success" /> : <ShieldOff className="size-5 text-muted-foreground" />}
            Tweestapsverificatie (2FA)
          </CardTitle>
          <Badge variant={enabled ? "success" : "secondary"}>{enabled ? "Aan" : "Uit"}</Badge>
        </div>
        <CardDescription>
          Met 2FA vraagt het panel na het inloggen met Discord ook om een code uit een authenticator-app (bijvoorbeeld Google Authenticator,
          1Password of Aegis).{isAdmin && " Voor beheerders is 2FA verplicht om de admin-kant te openen."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {done === "enabled" && (
          <Alert className="mb-4 border-success/40 bg-success/10 text-success">
            <ShieldCheck />
            <div>
              <AlertTitle>2FA staat aan</AlertTitle>
              <AlertDescription>Vanaf nu vraagt het panel bij elke login om een code.</AlertDescription>
            </div>
          </Alert>
        )}
        {done === "disabled" && (
          <Alert className="mb-4">
            <ShieldOff />
            <div>
              <AlertTitle>2FA staat uit</AlertTitle>
            </div>
          </Alert>
        )}
        {enabled ? <DisableTotp onDone={() => setDone("disabled")} /> : <EnableTotp onDone={() => setDone("enabled")} />}
      </CardContent>
    </Card>
  );
}

function EnableTotp({ onDone }: { onDone: () => void }) {
  const utils = trpc.useUtils();
  const setup = trpc.account.totpSetup.useMutation();
  const enable = trpc.account.totpEnable.useMutation({
    onSuccess: async () => {
      onDone();
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
          {setup.isPending && <Spinner />} 2FA aanzetten
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
        {qr ? <img src={qr} alt="QR-code voor je authenticator-app" width={200} height={200} /> : <Skeleton className="size-full bg-zinc-200" />}
      </div>
      <div className="space-y-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Scan de QR-code met je authenticator-app.</li>
          <li>Lukt scannen niet? Voer de sleutel hieronder handmatig in.</li>
          <li>Vul de 6-cijferige code in die de app laat zien.</li>
        </ol>
        <div className="flex items-center gap-1 rounded-md border border-border bg-muted/40 px-3 py-2">
          <code className="flex-1 break-all font-mono text-sm" data-testid="totp-secret">
            {setup.data.secret.replace(/(.{4})/g, "$1 ").trim()}
          </code>
          <CopyButton value={setup.data.secret} label="Sleutel kopiëren" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="totp-enable-code">Code uit de app</Label>
          <TotpCodeInput id="totp-enable-code" value={code} onChange={setCode} disabled={enable.isPending} invalid={!!enable.error} className="max-w-48" />
          {enable.error && <p className="text-sm text-destructive">{errorText(enable.error)}</p>}
        </div>
        <div className="flex gap-2">
          <Button type="submit" disabled={!isTotpCode(code) || enable.isPending}>
            {enable.isPending && <Spinner />} Bevestigen en aanzetten
          </Button>
          <Button variant="ghost" onClick={() => setup.reset()}>
            Annuleren
          </Button>
        </div>
      </div>
    </form>
  );
}

function DisableTotp({ onDone }: { onDone: () => void }) {
  const utils = trpc.useUtils();
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
        2FA uitzetten
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
          <AlertTitle>Weet je het zeker?</AlertTitle>
          <AlertDescription>Zonder 2FA is je account alleen beschermd door je Discord-login. Beheerders verliezen de toegang tot /admin.</AlertDescription>
        </div>
      </Alert>
      <Label htmlFor="totp-disable-code">Huidige code uit de app</Label>
      <TotpCodeInput id="totp-disable-code" value={code} onChange={setCode} autoFocus disabled={disable.isPending} invalid={!!disable.error} className="max-w-48" />
      {disable.error && <p className="text-sm text-destructive">{errorText(disable.error)}</p>}
      <div className="flex gap-2">
        <Button type="submit" variant="destructive" disabled={!isTotpCode(code) || disable.isPending}>
          {disable.isPending && <Spinner />} 2FA uitzetten
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Annuleren
        </Button>
      </div>
    </form>
  );
}
