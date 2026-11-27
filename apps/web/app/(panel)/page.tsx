"use client";
import { Plus, Server } from "lucide-react";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { QuotaMeters } from "@/app/_components/quota/quota-meters";
import { Button } from "@/app/_components/ui/button";
import { PageHeader } from "@/app/_components/page-header";
import { QueryError } from "@/app/_components/query-error";
import { ServerCard } from "@/app/_components/server-card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { Card } from "@/app/_components/ui/card";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function OverviewPage() {
  const t = useT();
  useDocumentTitle(t.overview.title);
  const servers = trpc.servers.list.useQuery(undefined, { refetchInterval: 30_000 });
  const quota = trpc.account.quota.useQuery(undefined, { retry: false });
  const list = servers.data ?? [];
  const online = list.filter((s) => s.status === "online").length;

  return (
    <>
      <PageHeader
        title={t.overview.title}
        description={servers.data ? t.overview.summary(list.length, online) : t.overview.fallback}
        actions={
          quota.data ? (
            <Button asChild>
              <Link href="/servers/new">
                <Plus /> {t.quota.newServer}
              </Link>
            </Button>
          ) : undefined
        }
      />
      {quota.data && (
        <Card className="mb-5 p-4 sm:mb-6" data-testid="quota-card">
          <div className="mb-3 text-sm font-medium">{t.quota.title}</div>
          <QuotaMeters overview={quota.data} />
        </Card>
      )}
      {servers.error ? (
        <QueryError error={servers.error} />
      ) : servers.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-64 rounded-2xl" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <Card data-testid="no-servers">
          <EmptyState icon={Server} title={t.overview.emptyTitle}>
            {quota.data ? t.quota.emptyHint : t.overview.emptyText}
          </EmptyState>
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
