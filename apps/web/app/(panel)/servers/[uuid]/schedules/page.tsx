"use client";
import { ScheduleManager } from "@/app/_components/schedules/schedule-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function SchedulesPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (!server.data.permissions.includes("schedule.manage")) return <NoPermission>{t.schedules.noAccess}</NoPermission>;
  return <ScheduleManager uuid={server.data.uuid} web={server.data.type === "web"} />;
}
