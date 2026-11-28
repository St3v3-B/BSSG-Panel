"use client";
import { NoPermission } from "@/app/_components/server/no-permission";
import { PlayersManager } from "@/app/_components/server/players-manager";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function PlayersPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (!server.data.permissions.includes("players.read")) return <NoPermission>{t.players.noAccess}</NoPermission>;
  return <PlayersManager server={server.data} />;
}
