"use client";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { getT, useT } from "@/app/_lib/i18n";

export const SFTP_MIN = 12;

/** Controle van een nieuw SFTP-wachtwoord (contract: 12–200 tekens). */
export function sftpPasswordError(pw: string, repeat: string): string | null {
  const t = getT().sftp;
  if (pw.length < SFTP_MIN) return t.minLength(SFTP_MIN);
  if (pw.length > 200) return t.maxLength;
  if (pw !== repeat) return t.mismatch;
  return null;
}

function Row({ label, value }: { label: string; value: string }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <code className="block truncate font-mono text-sm">{value}</code>
      </div>
      <CopyButton value={value} label={t.common.copyX(label)} />
    </div>
  );
}

/** SFTP-gegevens van een server (files.sftpDetails), met het wachtwoordformulier. */
export function SftpCard({ uuid }: { uuid: string }) {
  const details = trpc.files.sftpDetails.useQuery({ uuid }, { retry: false });
  const t = useT();
  return (
    <Card data-testid="sftp-card">
      <CardHeader>
        <CardTitle className="text-base">{t.sftp.title}</CardTitle>
        <CardDescription>{t.sftp.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {details.error ? (
          <QueryError error={details.error} />
        ) : !details.data ? (
          <Skeleton className="h-24" />
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-3">
              <Row label={t.sftp.host} value={details.data.host} />
              <Row label={t.sftp.port} value={String(details.data.port)} />
              <Row label={t.sftp.username} value={details.data.username} />
            </div>
            <Row label={t.sftp.address} value={`sftp://${details.data.username}@${details.data.host}:${details.data.port}`} />
          </>
        )}
        <SftpPasswordForm uuid={uuid} />
      </CardContent>
    </Card>
  );
}

export function SftpPasswordForm({ uuid, compact }: { uuid: string; compact?: boolean }) {
  const t = useT();
  const [pw, setPw] = useState("");
  const [repeat, setRepeat] = useState("");
  const [touched, setTouched] = useState(false);
  const set = trpc.account.setSftpPassword.useMutation({
    onSuccess: () => {
      setPw("");
      setRepeat("");
      setTouched(false);
    },
  });
  const err = sftpPasswordError(pw, repeat);
  return (
    <form
      className="space-y-3"
      data-testid="sftp-password-form"
      onSubmit={(e) => {
        e.preventDefault();
        setTouched(true);
        if (!err) set.mutate({ uuid, password: pw });
      }}
    >
      {!compact && (
        <div className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="size-4" /> {t.sftp.setPassword}
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`sftp-pw-${uuid}`}>{t.sftp.newPassword}</Label>
          <Input id={`sftp-pw-${uuid}`} type="password" autoComplete="new-password" value={pw} onChange={(e) => (setPw(e.target.value), set.reset())} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`sftp-pw2-${uuid}`}>{t.sftp.repeat}</Label>
          <Input id={`sftp-pw2-${uuid}`} type="password" autoComplete="new-password" value={repeat} onChange={(e) => (setRepeat(e.target.value), set.reset())} />
        </div>
      </div>
      {touched && err && <p className="text-xs text-destructive">{err}</p>}
      {set.error && <p className="text-sm text-destructive">{errorText(set.error)}</p>}
      {set.isSuccess && (
        <p className="text-sm text-success" role="status">
          {t.sftp.saved}
        </p>
      )}
      <Button type="submit" size="sm" disabled={set.isPending}>
        {set.isPending && <Spinner />} {t.sftp.savePassword}
      </Button>
    </form>
  );
}
