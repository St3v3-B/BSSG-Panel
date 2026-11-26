"use client";
import { Lock, ShieldAlert } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Spinner } from "@/app/_components/ui/spinner";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { decideAdmin } from "@/app/_lib/auth-routing";

/** /admin alleen voor admins met 2FA; de server controleert dit ook bij elke admin-procedure. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const me = trpc.auth.me.useQuery(undefined, { retry: false, staleTime: 30_000 });
  const decision = me.data ? decideAdmin(me.data) : null;
  useDocumentTitle(decision === "not_admin" ? "Geen toegang" : decision === "totp_required" ? "2FA vereist" : null);
  if (!me.data) return <Spinner className="mx-auto mt-16 size-6 text-muted-foreground" />;
  if (decision === "not_admin") {
    return (
      <Card className="mx-auto mt-8 max-w-lg space-y-3 p-8 text-center" data-testid="admin-forbidden">
        <Lock className="mx-auto size-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Geen toegang</h1>
        <p className="text-sm text-muted-foreground">De admin-kant is alleen voor beheerders.</p>
        <Button asChild variant="outline">
          <Link href="/">Naar mijn servers</Link>
        </Button>
      </Card>
    );
  }
  if (decision === "totp_required") {
    return (
      <Card className="mx-auto mt-8 max-w-lg space-y-3 p-8 text-center" data-testid="admin-totp-required">
        <ShieldAlert className="mx-auto size-8 text-warning" />
        <h1 className="text-lg font-semibold">Zet eerst 2FA aan</h1>
        <p className="text-sm text-muted-foreground">
          De admin-kant gaat pas open als je tweestapsverificatie (2FA) hebt aangezet. Zo kan niemand met alleen je Discord-account bij
          het beheer van alle servers.
        </p>
        <Button asChild>
          <Link href="/account">Naar je account</Link>
        </Button>
      </Card>
    );
  }
  return <>{children}</>;
}
