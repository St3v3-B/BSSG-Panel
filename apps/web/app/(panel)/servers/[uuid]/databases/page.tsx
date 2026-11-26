"use client";
import { DatabaseManager } from "@/app/_components/databases/database-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function DatabasesPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (!server.data.permissions.includes("database.manage")) return <NoPermission>{t.databases.noAccess}</NoPermission>;
  return <DatabaseManager uuid={server.data.uuid} />;
}
