"use client";
import { DeployManager } from "@/app/_components/deploy/deploy-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function DeployPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (server.data.type !== "web" || !server.data.permissions.includes("deploy.read")) return <NoPermission>{t.deploy.noAccess}</NoPermission>;
  return <DeployManager uuid={server.data.uuid} />;
}
