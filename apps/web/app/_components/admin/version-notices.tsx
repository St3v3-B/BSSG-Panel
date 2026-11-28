"use client";
import { ArrowUpCircle } from "lucide-react";
import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { useT } from "@/app/_lib/i18n";

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");

/** Panel-updates en achterlopende nodes; gedeeld door zijbalk, dashboard en nodespagina's (één query). */
export function useUpdatesSummary(enabled = true) {
  return trpc.admin.updates.summary.useQuery(undefined, { enabled, staleTime: 60_000, refetchInterval: 5 * 60_000, retry: false });
}

/** Meldingen bovenaan het admin-dashboard. */
export function UpdateNotices() {
  const t = useT().nodeUpdates;
  const q = useUpdatesSummary();
  const s = q.data;
  if (!s) return null;
  const nodes = s.outdatedNodes;
  if (!s.panelUpdates && nodes.length === 0) return null;
  return (
    <div className="space-y-3" data-testid="update-notices">
      {!!s.panelUpdates && (
        <Alert variant="info" data-testid="panel-update-notice">
          <ArrowUpCircle className="size-4" />
          <AlertTitle>{t.panelUpdate(s.panelUpdates)}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate">{s.latest ? t.panelUpdateText(s.latest.message || short(s.latest.sha)) : null}</span>
            <Button asChild size="sm" variant="outline">
              <Link href="/admin/settings/updates">{t.toUpdates}</Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {nodes.length > 0 && (
        <Alert variant="warning" data-testid="node-update-notice">
          <ArrowUpCircle className="size-4" />
          <AlertTitle>{t.nodesOutdated(nodes.length)}</AlertTitle>
          <AlertDescription className="space-y-2">
            <p>{t.nodesOutdatedText(nodes.map((n) => n.name).join(", "))}</p>
            <div className="flex flex-wrap gap-2">
              {nodes.map((n) => (
                <Button key={n.id} asChild size="sm" variant="outline">
                  <Link href={`/admin/nodes/${n.id}`}>{t.toNode(n.name)}</Link>
                </Button>
              ))}
            </div>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Badge bij een node waarvan de daemon uit een andere commit komt dan het panel. */
export function OutdatedBadge({ nodeId }: { nodeId: number }) {
  const t = useT().nodeUpdates;
  const s = useUpdatesSummary().data;
  const hit = s?.outdatedNodes.find((n) => n.id === nodeId);
  if (!hit) return null;
  return (
    <Badge variant="warning" title={t.badgeTitle(short(hit.commit), short(s?.panelCommit))} data-testid="node-outdated-badge">
      {t.badge}
    </Badge>
  );
}

/** Uitleg op de nodepagina. */
export function OutdatedNotice({ nodeId, isLocal }: { nodeId: number; isLocal: boolean }) {
  const t = useT().nodeUpdates;
  const s = useUpdatesSummary().data;
  const hit = s?.outdatedNodes.find((n) => n.id === nodeId);
  if (!hit) return null;
  const a = short(hit.commit);
  const b = short(s?.panelCommit);
  return (
    <Alert variant="warning" data-testid="node-outdated-notice">
      <ArrowUpCircle className="size-4" />
      <AlertTitle>{t.detailTitle}</AlertTitle>
      <AlertDescription>{isLocal ? t.detailLocal(a, b) : t.detailRemote(a, b)}</AlertDescription>
    </Alert>
  );
}
