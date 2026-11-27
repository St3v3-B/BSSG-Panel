"use client";
import { NoPermission } from "@/app/_components/server/no-permission";
import { StatsView } from "@/app/_components/stats/stats-view";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function StatsPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null; // de layout toont laden en fouten
  if (!server.data.permissions.includes("console.read")) return <NoPermission>{t.stats.noAccess}</NoPermission>;
  return <StatsView uuid={server.data.uuid} />;
}
