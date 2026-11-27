"use client";
import { AppsManager } from "@/app/_components/apps/apps-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function AppsPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (server.data.type !== "web" || !server.data.permissions.includes("files.write")) return <NoPermission>{t.apps.noAccess}</NoPermission>;
  return <AppsManager uuid={server.data.uuid} />;
}
