"use client";
import { Server } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { PageHeader } from "@/app/_components/page-header";
import { QueryError } from "@/app/_components/query-error";
import { ServerCard } from "@/app/_components/server-card";
import { Card } from "@/app/_components/ui/card";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";

export default function OverviewPage() {
  useDocumentTitle("Mijn servers");
  const servers = trpc.servers.list.useQuery(undefined, { refetchInterval: 30_000 });
  const list = servers.data ?? [];
  const online = list.filter((s) => s.status === "online").length;

  return (
    <>
      <PageHeader
        title="Mijn servers"
        description={servers.data ? `${list.length} ${list.length === 1 ? "server" : "servers"} · ${online} online` : "Je game-servers en websites"}
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
          <div className="font-medium">Je hebt nog geen servers</div>
          <p className="max-w-sm text-sm text-muted-foreground">
            Servers en websites worden aangemaakt door een beheerder. Zodra er een voor je klaarstaat, zie je hem hier.
          </p>
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
