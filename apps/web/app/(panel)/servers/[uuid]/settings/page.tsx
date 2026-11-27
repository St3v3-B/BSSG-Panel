"use client";
import { trpc } from "@/lib/trpc";
import { DeleteOwnCard, OwnLimitsCard } from "@/app/_components/quota/own-server-cards";
import { PhpSettingsCard } from "@/app/_components/server/php-settings-card";
import { NoPermission } from "@/app/_components/server/no-permission";
import { RenameCard, ReinstallCard, SleepCard, VariablesCard } from "@/app/_components/server/server-settings";
import { SftpCard } from "@/app/_components/server/sftp-card";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function ServerSettingsPage() {
  const server = useServer();
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 30_000 });
  const t = useT();
  const quota = trpc.account.quota.useQuery(undefined, { retry: false });
  if (!server.data) return null;
  const s = server.data;
  const perms = s.permissions;
  const manage = s.isOwner || !!me.data?.isAdmin;
  return (
    <div className="max-w-3xl space-y-6">
      {manage && <RenameCard key={s.name} server={s} />}
      {manage && s.type === "game" && <VariablesCard server={s} />}
      {manage && s.type === "web" && <PhpSettingsCard uuid={s.uuid} />}
      {manage && <SleepCard key={`s-${s.sleep.enabled}-${s.sleep.idleMinutes}`} server={s} />}
      {perms.includes("files.read") || perms.includes("files.write") ? (
        <SftpCard uuid={s.uuid} />
      ) : (
        <NoPermission>{t.sftp.noAccess}</NoPermission>
      )}
      {s.isOwner && quota.data && <OwnLimitsCard key={`l-${s.limits.ramMb}-${s.limits.diskMb}-${s.limits.cpuPct}`} server={s} />}
      {manage && <ReinstallCard server={s} />}
      {s.isOwner && quota.data && <DeleteOwnCard server={s} />}
    </div>
  );
}
