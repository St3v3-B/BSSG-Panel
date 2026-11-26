"use client";
import { DatabaseManager } from "@/app/_components/databases/database-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";

export default function DatabasesPage() {
  const server = useServer();
  if (!server.data) return null;
  if (!server.data.permissions.includes("database.manage")) return <NoPermission>Je hebt geen recht om de databases van deze server te beheren.</NoPermission>;
  return <DatabaseManager uuid={server.data.uuid} />;
}
