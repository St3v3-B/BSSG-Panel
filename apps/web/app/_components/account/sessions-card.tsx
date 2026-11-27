"use client";
import { Laptop, LogOut } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { QueryError } from "@/app/_components/query-error";

/** Maakt van een user agent een korte omschrijving ("Firefox op Linux"). */
export function describeAgent(ua: string | null, unknown: string): string {
  if (!ua) return unknown;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : null;
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : null;
  if (!browser && !os) return ua.slice(0, 60);
  return [browser, os].filter(Boolean).join(" · ");
}

export function SessionsCard() {
  const t = useT();
  const utils = trpc.useUtils();
  const list = trpc.account.sessions.useQuery();
  const refresh = () => utils.account.sessions.invalidate();
  const revoke = trpc.account.revokeSession.useMutation({ onSuccess: refresh });
  const revokeOthers = trpc.account.revokeOtherSessions.useMutation({ onSuccess: refresh });
  const others = list.data?.filter((s) => !s.current).length ?? 0;
  const error = revoke.error ?? revokeOthers.error;

  return (
    <Card data-testid="sessions-card">
      <CardHeader>
        <CardTitle className="text-base">{t.account.sessionsTitle}</CardTitle>
        <CardDescription>{t.account.sessionsText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.error ? (
          <QueryError error={list.error} />
        ) : !list.data ? (
          <Skeleton className="h-16 rounded-lg" />
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {list.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-3 p-3" data-testid="session-row">
                <Laptop className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {describeAgent(s.userAgent, t.account.sessionUnknown)}
                    {s.current && <Badge variant="success">{t.account.sessionCurrent}</Badge>}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {s.ip ?? "–"} · {t.account.sessionLastSeen(formatDate(s.lastSeenAt))}
                  </div>
                </div>
                {!s.current && (
                  <Button variant="outline" size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: s.id })}>
                    <LogOut /> {t.account.sessionSignOut}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-destructive">{errorText(error)}</p>}
        {others > 0 && (
          <Button variant="outline" disabled={revokeOthers.isPending} onClick={() => revokeOthers.mutate()} data-testid="sessions-revoke-others">
            {revokeOthers.isPending && <Spinner />} {t.account.sessionsSignOutOthers}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
