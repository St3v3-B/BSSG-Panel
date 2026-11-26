"use client";
import { Server } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { PageHeader } from "@/app/_components/page-header";
import { QueryError } from "@/app/_components/query-error";
import { ServerCard } from "@/app/_components/server-card";
import { Card } from "@/app/_components/ui/card";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function OverviewPage() {
  const t = useT();
  useDocumentTitle(t.overview.title);
  const servers = trpc.servers.list.useQuery(undefined, { refetchInterval: 30_000 });
  const list = servers.data ?? [];
  const online = list.filter((s) => s.status === "online").length;

  return (
    <>
      <PageHeader
        title={t.overview.title}
        description={servers.data ? t.overview.summary(list.length, online) : t.overview.fallback}
      />
      {servers.error ? (
        <QueryError error={servers.error} />
      ) : servers.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 p-12 text-center" data-testid="no-servers">
          <Server className="size-8 text-muted-foreground" />
          <div className="font-medium">{t.overview.emptyTitle}</div>
          <p className="max-w-sm text-sm text-muted-foreground">{t.overview.emptyText}</p>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="server-list">
          {list.map((s) => (
            <ServerCard key={s.uuid} server={s} />
          ))}
        </div>
      )}
    </>
  );
}
