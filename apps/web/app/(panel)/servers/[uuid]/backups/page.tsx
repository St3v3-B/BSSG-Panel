"use client";
import { BackupManager } from "@/app/_components/backups/backup-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function BackupsPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  const p = server.data.permissions;
  if (!p.includes("backup.create") && !p.includes("backup.restore")) return <NoPermission>{t.backups.noAccess}</NoPermission>;
  return <BackupManager uuid={server.data.uuid} permissions={p} />;
}
