"use client";
import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName } from "@/app/_components/user-avatar";
import { useDebounced } from "@/app/_hooks/use-debounced";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

/** Korte weergave van de metadata: key=value, lange waarden ingekort. */
export function metadataText(m: Record<string, unknown>): string {
  return Object.entries(m)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`.slice(0, 80))
    .join(" · ");
}

export function ActivityAdmin() {
  const t = useT();
  const a = t.admin.activity;
  const [userId, setUserId] = useState<number | undefined>();
  const [serverUuid, setServerUuid] = useState<string | undefined>();
  const [action, setAction] = useState("");
  const act = useDebounced(action.trim());
  const users = trpc.admin.users.list.useQuery({ limit: 100 });
  const servers = trpc.admin.servers.list.useQuery({ limit: 100 });
  const log = trpc.admin.activity.search.useInfiniteQuery(
    { limit: 50, userId, serverUuid, action: act || undefined },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  const filtered = userId != null || serverUuid != null || !!action;

  return (
    <div className="space-y-4" data-testid="activity-admin">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-52 space-y-1.5">
          <Label htmlFor="act-user">{a.user}</Label>
          <Select id="act-user" value={userId ?? ""} onChange={(e) => setUserId(e.target.value ? Number(e.target.value) : undefined)}>
            <option value="">{a.all}</option>
            {users.data?.items.map((u) => (
              <option key={u.id} value={u.id}>
                {displayName(u)}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-52 space-y-1.5">
          <Label htmlFor="act-server">{a.server}</Label>
          <Select id="act-server" value={serverUuid ?? ""} onChange={(e) => setServerUuid(e.target.value || undefined)}>
            <option value="">{a.all}</option>
            {servers.data?.items.map((s) => (
              <option key={s.uuid} value={s.uuid}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-56 space-y-1.5">
          <Label htmlFor="act-action">{a.action}</Label>
          <Input id="act-action" value={action} placeholder={a.actionPlaceholder} onChange={(e) => setAction(e.target.value)} className="font-mono" />
        </div>
        {filtered && (
          <Button variant="ghost" size="sm" onClick={() => (setUserId(undefined), setServerUuid(undefined), setAction(""))}>
            {a.reset}
          </Button>
        )}
      </div>
      {log.error ? (
        <QueryError error={log.error} />
      ) : log.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="activity-table">
              <thead className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{a.colWhen}</th>
                  <th className="px-4 py-2.5 font-medium">{a.colUser}</th>
                  <th className="px-4 py-2.5 font-medium">{a.colAction}</th>
                  <th className="px-4 py-2.5 font-medium">{a.colServer}</th>
                  <th className="px-4 py-2.5 font-medium">{a.colIp}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">
                      {a.empty}
                    </td>
                  </tr>
                )}
                {items.map((e) => (
                  <tr key={e.id} className="align-top hover:bg-muted/30" data-testid="activity-row">
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{formatDate(e.at)}</td>
                    <td className="px-4 py-2.5">{e.user ? displayName(e.user) : <span className="text-muted-foreground">{a.system}</span>}</td>
                    <td className="px-4 py-2.5">
                      <code className="font-mono text-xs">{e.action}</code>
                      {Object.keys(e.metadata).length > 0 && <div className="mt-0.5 break-all font-mono text-xs text-muted-foreground">{metadataText(e.metadata)}</div>}
                    </td>
                    <td className="px-4 py-2.5">
                      {e.serverUuid ? (
                        <Link href={`/servers/${e.serverUuid}`} className="hover:underline">
                          {e.serverName ?? e.serverUuid.slice(0, 8)}
                        </Link>
                      ) : (
                        "–"
                      )}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">{e.ip ?? "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {log.hasNextPage && (
            <div className="border-t border-border p-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => void log.fetchNextPage()} disabled={log.isFetchingNextPage}>
                {log.isFetchingNextPage && <Spinner />} {t.common.loadMore}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
