import type { ServerStatus } from "@panel/api";
import { Badge } from "@/app/_components/ui/badge";
import { STATUS_LABEL, STATUS_VARIANT } from "@/app/_lib/format";
import { cn } from "@/lib/utils";

const DOT: Record<ServerStatus, string> = {
  installing: "bg-info animate-pulse",
  install_failed: "bg-destructive",
  offline: "bg-muted-foreground",
  starting: "bg-warning animate-pulse",
  online: "bg-success",
  stopping: "bg-warning animate-pulse",
  disk_exceeded: "bg-destructive",
  unknown: "bg-muted-foreground",
};

export function StatusBadge({ status, className }: { status: ServerStatus; className?: string }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} className={className} data-status={status}>
      <span className={cn("size-1.5 rounded-full", DOT[status])} aria-hidden />
      {STATUS_LABEL[status]}
    </Badge>
  );
}
