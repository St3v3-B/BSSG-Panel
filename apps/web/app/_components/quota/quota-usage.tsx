"use client";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { displayName } from "@/app/_components/user-avatar";
import { useT } from "@/app/_lib/i18n";

/** Admin: verbruik per gebruiker (gebruikers met een quotum of servers). */
export function QuotaUsageTable() {
  const all = useT();
  const t = all.quota;
  const c = all.common;
  const usage = trpc.admin.quotas.usage.useInfiniteQuery({ limit: 50 }, { getNextPageParam: (l) => l.nextCursor ?? undefined });
  const items = usage.data?.pages.flatMap((p) => p.items) ?? [];
  const cell = (used: number, max: number | undefined) => (max === undefined ? `${used}` : `${used} / ${max}`);
  return (
    <Card data-testid="quota-usage">
      <CardHeader>
        <CardTitle className="text-base">{t.usageTitle}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {usage.error ? (
          <QueryError error={usage.error} />
        ) : usage.isPending ? (
          <Skeleton className="h-24 rounded-lg" />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-normal">{t.user}</th>
                <th className="py-1 pr-3 font-normal">{t.servers}</th>
                <th className="py-1 pr-3 font-normal">{t.ram}</th>
                <th className="py-1 pr-3 font-normal">{t.disk}</th>
                <th className="py-1 pr-3 font-normal">{t.cpu}</th>
                <th className="py-1 font-normal">{t.databases}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((i) => (
                <tr key={i.user.id}>
                  <td className="py-2 pr-3">
                    <Link href={`/admin/users/${i.user.id}`} className="font-medium hover:underline">
                      {displayName(i.user)}
                    </Link>
                    {!i.quota && <span className="ml-2 text-xs text-muted-foreground">{t.noQuotaRow}</span>}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{cell(i.usage.servers, i.quota?.maxServers)}</td>
                  <td className="py-2 pr-3 tabular-nums">{cell(i.usage.ramMb, i.quota?.maxRamMb)}</td>
                  <td className="py-2 pr-3 tabular-nums">{cell(i.usage.diskMb, i.quota?.maxDiskMb)}</td>
                  <td className="py-2 pr-3 tabular-nums">{cell(i.usage.cpuPct, i.quota?.maxCpuPct)}</td>
                  <td className="py-2 tabular-nums">{cell(i.usage.databases, i.quota?.maxDatabases)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {usage.hasNextPage && (
          <Button variant="ghost" className="mt-2" onClick={() => void usage.fetchNextPage()}>
            {c.loadMore}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
