"use client";
import { ArrowLeft, Gamepad2, Globe, Shield } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { trpc } from "@/lib/trpc";
import { CopyText } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { ServerTabs } from "@/app/_components/server/server-tabs";
import { StatusBadge } from "@/app/_components/status-badge";
import { Button } from "@/app/_components/ui/button";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { displayName } from "@/app/_components/user-avatar";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useServer } from "@/app/_hooks/use-server";
import { errorInfo } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

export default function ServerLayout({ children }: { children: ReactNode }) {
  const server = useServer();
  const t = useT();
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 30_000 });
  useDocumentTitle(server.data?.name ?? t.docTitle.server);

  if (server.error) {
    const code = errorInfo(server.error).code;
    return (
      <div className="space-y-4">
        <BackLink />
        <QueryError error={server.error} title={code === "NOT_FOUND" || code === "BAD_REQUEST" ? t.server.notFound : t.server.loadFailed} />
      </div>
    );
  }
  if (!server.data) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="flex items-center gap-4">
          <Skeleton className="size-14 rounded-2xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-56" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-[28rem] rounded-2xl" />
      </div>
    );
  }
  const s = server.data;
  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <BackLink />
          {me.data?.isAdmin && me.data.totpVerified && (
            <Button asChild variant="outline" size="sm" data-testid="admin-manage">
              <Link href={`/admin/servers/${s.uuid}`}>
                <Shield /> {t.adminServer.manage}
              </Link>
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3 sm:items-center sm:gap-4">
            <span className="relative grid size-12 shrink-0 place-items-center rounded-2xl border border-border bg-card text-primary shadow-card sm:size-14">
              <span aria-hidden className={`absolute inset-0 -z-10 rounded-2xl blur-xl ${s.status === "online" ? "bg-success/30" : "bg-primary/10"}`} />
              {s.type === "web" ? <Globe className="size-6" /> : <Gamepad2 className="size-6" />}
            </span>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 className="line-clamp-2 break-words text-2xl font-bold tracking-tight sm:text-3xl">{s.name}</h1>
                <StatusBadge status={s.status} lastSeenAt={s.lastSeenAt} />
              </div>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                {s.primaryAddress && <CopyText value={s.primaryAddress} className="text-foreground" />}
                <span className="basis-full sm:basis-auto">
                  {s.templateName} · {s.node.name}
                  {!s.isOwner && <> · {t.server.of(displayName(s.owner))}</>}
                </span>
              </div>
            </div>
          </div>
        </div>
        <ServerTabs server={s} />
      </div>
      {children}
    </div>
  );
}

function BackLink() {
  const t = useT();
  return (
    <Link href="/" className="-ml-1 inline-flex min-h-8 items-center gap-1 rounded-lg px-1 text-sm text-muted-foreground transition-colors hover:text-foreground">
      <ArrowLeft className="size-4" /> {t.nav.myServers}
    </Link>
  );
}
