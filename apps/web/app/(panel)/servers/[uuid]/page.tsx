"use client";
import { ServerView } from "@/app/_components/server/server-view";
import { useServer } from "@/app/_hooks/use-server";

export default function ServerPage() {
  const server = useServer();
  if (!server.data) return null; // de layout toont laden en fouten
  return <ServerView server={server.data} />;
}
