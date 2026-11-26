"use client";
import { DomainManager } from "@/app/_components/domains/domain-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";

export default function DomainsPage() {
  const server = useServer();
  if (!server.data) return null;
  if (server.data.type !== "web") return <NoPermission>Domeinen koppel je aan websites; deze server is een game-server.</NoPermission>;
  if (!server.data.permissions.includes("domain.manage")) return <NoPermission>Je hebt geen recht om de domeinen van deze site te beheren.</NoPermission>;
  return <DomainManager uuid={server.data.uuid} />;
}
