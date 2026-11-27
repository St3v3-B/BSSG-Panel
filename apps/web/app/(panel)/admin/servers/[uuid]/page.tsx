"use client";
import { ArrowLeft, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { DeleteServerCard, DomainsAllowedSection, LimitsCard, MoveNodeCard, OwnerCard, PortsCard, SuspendSection, TemplateSection } from "@/app/_components/admin/server-manage";
import { QueryError } from "@/app/_components/query-error";
import { RenameCard, ReinstallCard, SleepCard, VariablesCard } from "@/app/_components/server/server-settings";
import { StatusBadge } from "@/app/_components/status-badge";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";
import { trpc } from "@/lib/trpc";

/** Server beheren als admin: limieten, eigenaar, poorten, variabelen, naam, herinstalleren, verwijderen. */
export default function AdminServerPage() {
  const { uuid } = useParams<{ uuid: string }>();
  const router = useRouter();
  const t = useT();
  const server = trpc.servers.get.useQuery({ uuid }, { retry: false });
  useDocumentTitle(server.data ? `${t.adminServer.docTitle} · ${server.data.name}` : t.adminServer.docTitle);
  const s = server.data;
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/admin/servers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {t.adminServer.back}
      </Link>
      {server.error ? (
        <QueryError error={server.error} title={t.server.notFound} />
      ) : !s ? (
        <Skeleton className="h-96 rounded-xl" />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
                {s.name} <StatusBadge status={s.status} />
                {s.suspended && <Badge variant="warning">{t.admin2.list.suspended}</Badge>}
              </h1>
              <p className="text-sm text-muted-foreground">
                <code className="font-mono">{s.shortId}</code> · {s.templateName} · {s.node.name}
              </p>
            </div>
            <Button asChild variant="outline">
              <Link href={`/servers/${s.uuid}`}>
                <ExternalLink /> {t.adminServer.openServer}
              </Link>
            </Button>
          </div>
          <SuspendSection uuid={s.uuid} suspended={s.suspended} />
          <TemplateSection uuid={s.uuid} type={s.type} currentName={s.templateName} />
          <LimitsCard key={`l-${JSON.stringify(s.limits)}`} server={s} />
          <OwnerCard server={s} />
          {s.type === "game" && <DomainsAllowedSection uuid={s.uuid} allowed={s.domainsAllowed} />}
          {s.type === "game" && <PortsCard key={`p-${s.allocations.map((a) => a.id).join()}`} server={s} />}
          <MoveNodeCard key={`m-${s.node.id}`} server={s} />
          <VariablesCard server={s} all />
          <SleepCard key={`s-${s.sleep.enabled}-${s.sleep.idleMinutes}`} server={s} />
          <RenameCard server={s} />
          <ReinstallCard server={s} />
          <DeleteServerCard server={s} onDeleted={() => router.push("/admin/servers")} />
        </>
      )}
    </div>
  );
}
