"use client";
import { Ban, CircleAlert, KeyRound, LogOut } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { BrandMark } from "@/app/_components/branding";
import { LocaleSwitcher } from "@/app/_components/locale-switcher";
import { isTotpCode, TotpCodeInput } from "@/app/_components/totp-code-input";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Label } from "@/app/_components/ui/label";
import { Spinner } from "@/app/_components/ui/spinner";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { safeRedirect } from "@/app/_lib/auth-routing";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

export default function LoginPage() {
  const t = useT();
  useDocumentTitle(t.login.docTitle);
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden p-4">
      <LocaleSwitcher className="absolute right-4 top-4 z-10" />
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-96 bg-gradient-to-b from-primary/10 to-transparent" />
      <div className="relative w-full max-w-sm space-y-8">
        <BrandMark size="lg" className="justify-center" />
        <Suspense fallback={<Card className="h-48" />}>
          <LoginFlow />
        </Suspense>
      </div>
    </div>
  );
}


function LoginFlow() {
  const router = useRouter();
  const t = useT();
  const params = useSearchParams();
  const redirectTo = safeRedirect(params.get("redirectTo"));
  const callbackError = params.get("error");
  const me = trpc.auth.me.useQuery(undefined, { retry: false });
  const done = !!me.data && (!me.data.totpEnabled || me.data.totpVerified);

  useEffect(() => {
    if (done) router.replace(redirectTo);
  }, [done, redirectTo, router]);

  if (me.isPending || done) {
    return (
      <div className="grid h-48 place-items-center" data-testid="login-loading">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }
  if (me.data && me.data.totpEnabled && !me.data.totpVerified) return <TotpStep redirectTo={redirectTo} name={me.data.user.name} />;

  // Foutcodes die de Discord-callback als ?error= kan meegeven.
  const callbacks = t.login.callback as Record<string, { title: string; text: string }>;
  const key = callbackError?.toLowerCase() ?? "";
  const err = callbackError
    ? { ...(callbacks[key] ?? { title: t.login.failedTitle, text: t.login.failedText }), blocked: key === "blocked" }
    : null;
  return (
    <div className="space-y-4">
      {err && (
        <Alert variant="destructive" data-testid={err.blocked ? "login-blocked" : "login-error"}>
          {err.blocked ? <Ban /> : <CircleAlert />}
          <div>
            <AlertTitle>{err.title}</AlertTitle>
            <AlertDescription>{err.text}</AlertDescription>
          </div>
        </Alert>
      )}
      <DiscordStep redirectTo={redirectTo} />
    </div>
  );
}

function DiscordIcon(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

function DiscordStep({ redirectTo }: { redirectTo: string }) {
  const login = trpc.auth.discordLoginUrl.useQuery({ redirectTo }, { retry: 1, staleTime: 60_000 });
  const t = useT();
  return (
    <Card>
      <CardHeader className="text-center">
        <CardTitle className="text-lg">{t.login.title}</CardTitle>
        <CardDescription>{t.login.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {login.error ? (
          <p className="text-center text-sm text-destructive">{errorText(login.error)}</p>
        ) : (
          <Button asChild size="lg" className="w-full bg-[#5865F2] text-white hover:bg-[#4752c4]" aria-disabled={!login.data}>
            <a href={login.data?.url ?? "#"} data-testid="discord-login" onClick={(e) => !login.data && e.preventDefault()}>
              <DiscordIcon className="size-5" /> {t.login.discord}
            </a>
          </Button>
        )}
        <p className="text-center text-xs text-muted-foreground">{t.login.noAccount}</p>
      </CardContent>
    </Card>
  );
}

function TotpStep({ redirectTo, name }: { redirectTo: string; name: string | null }) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const t = useT();
  const [code, setCode] = useState("");
  const verify = trpc.auth.verifyTotp.useMutation({
    onSuccess: async () => {
      await utils.invalidate();
      router.replace(redirectTo);
    },
    onError: () => setCode(""),
  });
  const logout = trpc.auth.logout.useMutation({ onSettled: () => window.location.assign("/login") });

  return (
    <Card data-testid="totp-step">
      <CardHeader className="text-center">
        <span className="mx-auto mb-2 grid size-10 place-items-center rounded-full bg-primary/15 text-primary">
          <KeyRound className="size-5" />
        </span>
        <CardTitle className="text-lg">{t.login.totpTitle}</CardTitle>
        <CardDescription>{t.login.totpText(name)}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (isTotpCode(code)) verify.mutate({ code });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="totp-code" className="sr-only">
              {t.login.code}
            </Label>
            <TotpCodeInput value={code} onChange={setCode} autoFocus disabled={verify.isPending} invalid={!!verify.error} />
            {verify.error && <p className="text-center text-sm text-destructive">{errorText(verify.error)}</p>}
          </div>
          <Button type="submit" className="w-full" disabled={!isTotpCode(code) || verify.isPending}>
            {verify.isPending && <Spinner />} {t.login.confirm}
          </Button>
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={() => logout.mutate()} disabled={logout.isPending}>
            <LogOut /> {t.nav.logout}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
