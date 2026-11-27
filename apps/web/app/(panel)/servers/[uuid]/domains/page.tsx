"use client";
import { DomainManager } from "@/app/_components/domains/domain-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function DomainsPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (server.data.type !== "web" && !server.data.domainsAllowed) return <NoPermission>{t.domains.notWeb}</NoPermission>;
  if (!server.data.permissions.includes("domain.manage")) return <NoPermission>{t.domains.noAccess}</NoPermission>;
  return <DomainManager uuid={server.data.uuid} isWeb={server.data.type === "web"} />;
}
