"use client";
import { Wrench } from "lucide-react";
import type { ServerSummary } from "@panel/api";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

/** Banner voor eigenaren: de node van deze server is in onderhoud. */
export function MaintenanceNotice({ maintenance }: { maintenance: ServerSummary["maintenance"] }) {
  const t = useT().hostops.maint;
  if (!maintenance) return null;
  const from = maintenance.plannedStart ?? maintenance.since;
  return (
    <Alert variant="warning" data-testid="maintenance-notice">
      <Wrench />
      <div className="min-w-0 flex-1">
        <AlertTitle>{maintenance.plannedEnd ? t.bannerTitleUntil(formatDate(from), formatDate(maintenance.plannedEnd)) : t.bannerTitle(formatDate(from))}</AlertTitle>
        <AlertDescription className="break-words">{maintenance.message ?? t.bannerText}</AlertDescription>
      </div>
    </Alert>
  );
}
