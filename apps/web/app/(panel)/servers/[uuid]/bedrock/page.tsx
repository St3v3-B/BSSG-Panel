"use client";
import { BedrockManager } from "@/app/_components/server/bedrock-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function BedrockPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (!server.data.isOwner && !server.data.permissions.includes("files.write")) return <NoPermission>{t.bedrock.noAccess}</NoPermission>;
  return <BedrockManager server={server.data} />;
}
