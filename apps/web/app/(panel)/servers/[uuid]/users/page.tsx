"use client";
import { NoPermission } from "@/app/_components/server/no-permission";
import { SubuserManager } from "@/app/_components/server/subuser-manager";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function ServerUsersPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (!server.data.isOwner) return <NoPermission>{t.subusers.ownerOnly}</NoPermission>;
  return <SubuserManager uuid={server.data.uuid} />;
}
