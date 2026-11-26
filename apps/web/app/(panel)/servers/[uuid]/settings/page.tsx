"use client";
import { trpc } from "@/lib/trpc";
import { NoPermission } from "@/app/_components/server/no-permission";
import { RenameCard, ReinstallCard, VariablesCard } from "@/app/_components/server/server-settings";
import { SftpCard } from "@/app/_components/server/sftp-card";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function ServerSettingsPage() {
  const server = useServer();
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 30_000 });
  const t = useT();
  if (!server.data) return null;
  const s = server.data;
  const perms = s.permissions;
  const manage = s.isOwner || !!me.data?.isAdmin;
  return (
    <div className="max-w-3xl space-y-6">
      {manage && <RenameCard key={s.name} server={s} />}
      {manage && s.type === "game" && <VariablesCard server={s} />}
      {perms.includes("files.read") || perms.includes("files.write") ? (
        <SftpCard uuid={s.uuid} />
      ) : (
        <NoPermission>{t.sftp.noAccess}</NoPermission>
      )}
      {manage && <ReinstallCard server={s} />}
    </div>
  );
}
