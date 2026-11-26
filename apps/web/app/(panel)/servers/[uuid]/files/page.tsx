"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import type { ServerDetail } from "@panel/api";
import { FileEditor } from "@/app/_components/files/file-editor";
import { FileManager } from "@/app/_components/files/file-manager";
import { NoPermission } from "@/app/_components/server/no-permission";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { useServer } from "@/app/_hooks/use-server";
import { normalizePath, parentPath } from "@/app/_lib/files";
import { useT } from "@/app/_lib/i18n";

export default function FilesPage() {
  const server = useServer();
  const t = useT();
  if (!server.data) return null;
  if (!server.data.permissions.includes("files.read")) return <NoPermission>{t.files.noRead}</NoPermission>;
  return (
    <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
      <Files server={server.data} />
    </Suspense>
  );
}

function Files({ server }: { server: ServerDetail }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const path = normalizePath(params.get("path") ?? "/");
  const edit = params.get("edit");
  const go = (q: Record<string, string>) => router.push(`${pathname}?${new URLSearchParams(q).toString()}`);

  if (edit) {
    const file = normalizePath(edit);
    return <FileEditor key={file} uuid={server.uuid} path={file} readOnly={!server.permissions.includes("files.write")} onClose={() => go({ path: parentPath(file) })} />;
  }
  return <FileManager server={server} path={path} onNavigate={(p) => go({ path: p })} onEdit={(p) => go({ edit: p })} />;
}
