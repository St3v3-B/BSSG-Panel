import { Moon } from "lucide-react";
import type { ServerStatus } from "@panel/api";
import { Badge } from "@/app/_components/ui/badge";
import { formatDate, statusLabel, STATUS_VARIANT } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";

const DOT: Record<ServerStatus, string> = {
  installing: "bg-info animate-pulse",
  install_failed: "bg-destructive",
  offline: "bg-muted-foreground",
  starting: "bg-warning animate-pulse",
  online: "bg-success shadow-[0_0_0_3px_color-mix(in_oklab,var(--success)_25%,transparent)]",
  stopping: "bg-warning animate-pulse",
  disk_exceeded: "bg-destructive",
  sleeping: "bg-indigo-400",
  unknown: "bg-muted-foreground",
};

/** Bij `unknown` toont de tooltip wanneer de node de server voor het laatst bevestigde. */
export function StatusBadge({ status, className, lastSeenAt }: { status: ServerStatus; className?: string; lastSeenAt?: Date | null }) {
  const t = useT();
  const title = status === "unknown" && lastSeenAt !== undefined ? (lastSeenAt ? t.common.lastSeen(formatDate(lastSeenAt)) : t.common.neverSeen) : undefined;
  return (
    <Badge variant={STATUS_VARIANT[status]} className={className} data-status={status} title={title}>
      {status === "sleeping" ? <Moon aria-hidden /> : <span className={cn("size-1.5 rounded-full", DOT[status])} aria-hidden />}
      {statusLabel(status)}
    </Badge>
  );
}
