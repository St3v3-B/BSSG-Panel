"use client";
import { NoPermission } from "@/app/_components/server/no-permission";
import { PlayerActivityView } from "@/app/_components/server/player-activity";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function ActivityPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (!server.data.permissions.includes("players.read")) return <NoPermission>{t.playerActivity.noAccess}</NoPermission>;
  return <PlayerActivityView uuid={server.data.uuid} />;
}
