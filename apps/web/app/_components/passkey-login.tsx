"use client";
import { Fingerprint } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/app/_components/ui/button";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorInfo, errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";
import { getPasskey, PasskeyCancelled, usePasskeySupport } from "@/app/_lib/passkey";

/** tRPC-fouten vertaald; andere (browser)fouten als algemene melding; afbreken is geen fout. */
function usePasskeyError() {
  const t = useT();
  return (e: unknown): string | null => {
    if (e instanceof PasskeyCancelled) return null;
    return errorInfo(e).code ? errorText(e) : t.login.passkey.failed;
  };
}

/** Knop "Inloggen met passkey" (alleen als de browser WebAuthn kent). */
export function PasskeyLoginButton({ redirectTo }: { redirectTo: string }) {
  const t = useT();
  const router = useRouter();
  const utils = trpc.useUtils();
  const supported = usePasskeySupport();
  const options = trpc.auth.passkeyLoginOptions.useMutation();
  const login = trpc.auth.passkeyLogin.useMutation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toError = usePasskeyError();
  if (!supported) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = await options.mutateAsync();
      const response = await getPasskey(opts);
      await login.mutateAsync({ response });
      await utils.invalidate();
      router.replace(redirectTo);
    } catch (e) {
      setError(toError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="lg" className="w-full" onClick={run} disabled={busy} data-testid="passkey-login">
        {busy ? <Spinner /> : <Fingerprint className="size-5" />} {t.login.passkey.button}
      </Button>
      {busy && <p className="text-center text-xs text-muted-foreground">{t.login.passkey.waiting}</p>}
      {error && (
        <p className="text-center text-sm text-destructive" data-testid="passkey-login-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** In de TOTP-stap: verifiëren met een passkey in plaats van een code. */
export function PasskeyVerifyButton({ onVerified }: { onVerified: () => void | Promise<void> }) {
  const t = useT();
  const supported = usePasskeySupport();
  const options = trpc.auth.passkeyVerifyOptions.useMutation();
  const verify = trpc.auth.passkeyVerify.useMutation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toError = usePasskeyError();
  if (!supported) return null;

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const opts = await options.mutateAsync();
      const response = await getPasskey(opts);
      await verify.mutateAsync({ response });
      await onVerified();
    } catch (e) {
      setError(toError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" className="w-full" onClick={run} disabled={busy} data-testid="passkey-verify">
        {busy ? <Spinner /> : <Fingerprint />} {t.login.passkey.useInStep}
      </Button>
      {error && (
        <p className="text-center text-sm text-destructive" data-testid="passkey-verify-error">
          {error}
        </p>
      )}
    </div>
  );
}
