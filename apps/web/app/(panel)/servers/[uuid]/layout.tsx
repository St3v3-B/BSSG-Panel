"use client";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { CopyText } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { ServerTabs } from "@/app/_components/server/server-tabs";
import { StatusBadge } from "@/app/_components/status-badge";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { displayName } from "@/app/_components/user-avatar";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useServer } from "@/app/_hooks/use-server";
import { errorInfo } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

export default function ServerLayout({ children }: { children: ReactNode }) {
  const server = useServer();
  const t = useT();
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
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[32rem] rounded-xl" />
      </div>
    );
  }
  const s = server.data;
  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <BackLink />
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{s.name}</h1>
            <StatusBadge status={s.status} />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {s.primaryAddress && <CopyText value={s.primaryAddress} className="text-foreground" />}
            <span>{s.templateName}</span>
            <span>· {s.node.name}</span>
            {!s.isOwner && <span>· {t.server.of(displayName(s.owner))}</span>}
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
    <Link href="/" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" /> {t.nav.myServers}
    </Link>
  );
}
