"use client";
import { NetworkManager } from "@/app/_components/server/network-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function NetworkPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (server.data.network.role !== "proxy") return <NoPermission>{t.network.notProxy}</NoPermission>;
  return <NetworkManager server={server.data} />;
}
