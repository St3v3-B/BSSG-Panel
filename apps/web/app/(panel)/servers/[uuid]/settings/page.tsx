"use client";
import { SftpCard } from "@/app/_components/server/sftp-card";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";

export default function ServerSettingsPage() {
  const server = useServer();
  if (!server.data) return null;
  const perms = server.data.permissions;
  return (
    <div className="max-w-3xl space-y-6">
      {perms.includes("files.read") || perms.includes("files.write") ? (
        <SftpCard uuid={server.data.uuid} />
      ) : (
        <NoPermission>SFTP is alleen beschikbaar met het recht om bestanden te lezen.</NoPermission>
      )}
    </div>
  );
}
