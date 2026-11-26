"use client";
import { NoPermission } from "@/app/_components/server/no-permission";
import { SubuserManager } from "@/app/_components/server/subuser-manager";
import { useServer } from "@/app/_hooks/use-server";

export default function ServerUsersPage() {
  const server = useServer();
  if (!server.data) return null;
  if (!server.data.isOwner) return <NoPermission>Alleen de eigenaar van de server kan gebruikers toevoegen en rechten geven.</NoPermission>;
  return <SubuserManager uuid={server.data.uuid} />;
}
