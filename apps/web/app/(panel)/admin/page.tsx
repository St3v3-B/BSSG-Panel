"use client";
import { Plus, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { PageHeader } from "@/app/_components/page-header";
import { QueryError } from "@/app/_components/query-error";
import { StatusBadge } from "@/app/_components/status-badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { displayName } from "@/app/_components/user-avatar";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { formatCpuLimit, formatMb } from "@/app/_lib/format";

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function AdminServersPage() {
  useDocumentTitle("Admin · servers");
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const servers = trpc.admin.servers.list.useInfiniteQuery(
    { limit: 50, search: q || undefined },
    { getNextPageParam: (last) => last.nextCursor ?? undefined },
  );
  const items = servers.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Alle servers"
        description="Game-servers en websites van alle gebruikers"
        actions={
          <Button asChild>
            <Link href="/admin/servers/new" data-testid="create-server-link">
              <Plus /> Server aanmaken
            </Link>
          </Button>
        }
      />
      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input placeholder="Zoeken op naam…" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" aria-label="Zoeken" />
      </div>
      {servers.error ? (
        <QueryError error={servers.error} />
      ) : servers.isPending ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm" data-testid="admin-server-table">
              <thead className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Naam</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Eigenaar</th>
                  <th className="px-4 py-2.5 font-medium">Template</th>
                  <th className="px-4 py-2.5 font-medium">Adres</th>
                  <th className="px-4 py-2.5 font-medium">Limieten</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                      {q ? `Geen servers gevonden voor “${q}”.` : "Er zijn nog geen servers."}
                    </td>
                  </tr>
                )}
                {items.map((s) => (
                  <tr key={s.uuid} className="hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link href={`/servers/${s.uuid}`} className="font-medium hover:underline">
                        {s.name}
                      </Link>
                      <div className="font-mono text-xs text-muted-foreground">{s.shortId}</div>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={s.status} />
                    </td>
                    <td className="px-4 py-3">{displayName(s.owner)}</td>
                    <td className="px-4 py-3">
                      {s.templateName}
                      <div className="text-xs text-muted-foreground">{s.nodeName}</div>
                    </td>
                    <td className="px-4 py-3">
                      {s.primaryAddress ? (
                        <span className="inline-flex items-center gap-1">
                          <code className="font-mono text-xs">{s.primaryAddress}</code>
                          <CopyButton value={s.primaryAddress} label="Adres kopiëren" />
                        </span>
                      ) : (
                        <span className="text-muted-foreground">–</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-muted-foreground">
                      {formatCpuLimit(s.limits.cpuPct)} · {formatMb(s.limits.ramMb)} · {s.limits.diskMb ? formatMb(s.limits.diskMb) : "∞"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {servers.hasNextPage && (
            <div className="border-t border-border p-3 text-center">
              <Button variant="ghost" size="sm" onClick={() => void servers.fetchNextPage()} disabled={servers.isFetchingNextPage}>
                {servers.isFetchingNextPage && <Spinner />} Meer laden
              </Button>
            </div>
          )}
        </Card>
      )}
    </>
  );
}
