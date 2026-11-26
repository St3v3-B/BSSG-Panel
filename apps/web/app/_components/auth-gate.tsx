"use client";
import { Ban } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import type { Me } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { BrandMark } from "@/app/_components/branding";
import { Button } from "@/app/_components/ui/button";
import { Spinner } from "@/app/_components/ui/spinner";
import { decideGate } from "@/app/_lib/auth-routing";
import { isBlocked, isTotpPending, isUnauthorized } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

/**
 * Laat de kinderen alleen zien met een volledige sessie (ingelogd, 2FA afgerond, niet
 * geblokkeerd). Anders naar /login of het geblokkeerd-scherm. De server dwingt dit ook af.
 */
export function AuthGate({ children }: { children: (me: Me) => ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const me = trpc.auth.me.useQuery(undefined, { retry: false, staleTime: 30_000 });
  const ready = !!me.data && (!me.data.totpEnabled || me.data.totpVerified);
  // account.get is een user-procedure: die faalt met BLOCKED / TOTP_PENDING als de sessie niet volledig is.
  const account = trpc.account.get.useQuery(undefined, { enabled: ready, retry: false, staleTime: 30_000 });
  const accountError = account.error
    ? { blocked: isBlocked(account.error), totpPending: isTotpPending(account.error), unauthorized: isUnauthorized(account.error) }
    : null;

  const decision = decideGate({ pathname, me: me.data, meError: me.error, accountError });
  const target = decision.kind === "redirect" ? decision.to : null;

  useEffect(() => {
    if (target) router.replace(target);
  }, [target, router]);

  if (decision.kind === "blocked") return <BlockedScreen />;
  if (decision.kind !== "ok" || !me.data || (ready && account.isPending)) {
    return (
      <div className="grid min-h-screen place-items-center" data-testid="auth-loading">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }
  return <>{children(me.data)}</>;
}

export function BlockedScreen() {
  const t = useT();
  const logout = trpc.auth.logout.useMutation({ onSettled: () => window.location.assign("/login") });
  return (
    <div className="grid min-h-screen place-items-center p-4" data-testid="blocked">
      <div className="w-full max-w-md space-y-6 text-center">
        <BrandMark size="lg" className="justify-center" />
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-6">
          <Ban className="mx-auto mb-3 size-8 text-destructive" />
          <h1 className="text-lg font-semibold">{t.blocked.title}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{t.blocked.text}</p>
        </div>
        <Button variant="outline" onClick={() => logout.mutate()} disabled={logout.isPending}>
          {t.nav.logout}
        </Button>
      </div>
    </div>
  );
}
