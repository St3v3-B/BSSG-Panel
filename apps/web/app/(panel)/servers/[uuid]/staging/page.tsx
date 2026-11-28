"use client";
import { trpc } from "@/lib/trpc";
import { PublishManager } from "@/app/_components/publish/publish-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function StagingPage() {
  const server = useServer();
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 30_000 });
  const t = useT();
  if (!server.data) return null;
  if (server.data.type !== "web") return <NoPermission>{t.publish.notWeb}</NoPermission>;
  const admin = !!me.data?.isAdmin && !!me.data.totpVerified;
  return <PublishManager server={server.data} canCreate={server.data.isOwner || admin} />;
}
