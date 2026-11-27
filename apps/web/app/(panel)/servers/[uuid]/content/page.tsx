"use client";
import { ContentManager } from "@/app/_components/server/content-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function ContentPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (!server.data.permissions.includes("files.read")) return <NoPermission>{t.files.noRead}</NoPermission>;
  return <ContentManager server={server.data} />;
}
