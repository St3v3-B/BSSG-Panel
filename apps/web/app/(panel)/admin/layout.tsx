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
import { useT } from "@/app/_lib/i18n";

/** /admin alleen voor admins met 2FA; de server controleert dit ook bij elke admin-procedure. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  const me = trpc.auth.me.useQuery(undefined, { retry: false, staleTime: 30_000 });
  const decision = me.data ? decideAdmin(me.data) : null;
  const t = useT();
  useDocumentTitle(decision === "not_admin" ? t.adminGate.forbiddenDoc : decision === "totp_required" ? t.adminGate.totpDoc : null);
  if (!me.data) return <Spinner className="mx-auto mt-16 size-6 text-muted-foreground" />;
  if (decision === "not_admin") {
    return (
      <Card className="mx-auto mt-8 max-w-lg space-y-3 p-8 text-center" data-testid="admin-forbidden">
        <Lock className="mx-auto size-8 text-muted-foreground" />
        <h1 className="text-lg font-semibold">{t.adminGate.forbiddenTitle}</h1>
        <p className="text-sm text-muted-foreground">{t.adminGate.forbiddenText}</p>
        <Button asChild variant="outline">
          <Link href="/">{t.adminGate.back}</Link>
        </Button>
      </Card>
    );
  }
  if (decision === "totp_required") {
    return (
      <Card className="mx-auto mt-8 max-w-lg space-y-3 p-8 text-center" data-testid="admin-totp-required">
        <ShieldAlert className="mx-auto size-8 text-warning" />
        <h1 className="text-lg font-semibold">{t.adminGate.totpTitle}</h1>
        <p className="text-sm text-muted-foreground">{t.adminGate.totpText}</p>
        <Button asChild>
          <Link href="/account">{t.adminGate.totpLink}</Link>
        </Button>
      </Card>
    );
  }
  return (
    <>{children}</>
  );
}
