"use client";
import { CheckCircle2, CircleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { BrandMark } from "@/app/_components/branding";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Spinner } from "@/app/_components/ui/spinner";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";
import { trpc } from "@/lib/trpc";

export default function VerifyEmailPage() {
  const t = useT().notif2;
  useDocumentTitle(t.verifyTitle);
  return (
    <div className="grid min-h-dvh place-items-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <BrandMark size="lg" stacked className="justify-center" />
        <Suspense fallback={<Card className="h-40" />}>
          <Verify />
        </Suspense>
      </div>
    </div>
  );
}

function Verify() {
  const t = useT().notif2;
  const token = useSearchParams()?.get("token") ?? "";
  const verify = trpc.auth.verifyEmail.useMutation();
  const started = useRef(false);
  useEffect(() => {
    // Eén keer, ook in StrictMode: de link is eenmalig.
    if (started.current || token.length < 20) return;
    started.current = true;
    verify.mutate({ token });
  }, [token, verify]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.verifyTitle}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {token.length < 20 ? (
          <p className="flex gap-2 text-sm text-destructive"><CircleAlert className="size-4 shrink-0" /> {t.missingToken}</p>
        ) : verify.isSuccess ? (
          <p className="flex gap-2 text-sm text-success" role="status"><CheckCircle2 className="size-4 shrink-0" /> {t.verified(verify.data.email)}</p>
        ) : verify.isError ? (
          <p className="flex gap-2 text-sm text-destructive" role="alert"><CircleAlert className="size-4 shrink-0" /> {errorText(verify.error)}</p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> {t.verifying}</p>
        )}
        <Button asChild variant="outline" className="w-full">
          <Link href="/account">{t.toAccount}</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
