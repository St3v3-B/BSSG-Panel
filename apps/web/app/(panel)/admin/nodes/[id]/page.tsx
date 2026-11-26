"use client";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { NodeDetail } from "@/app/_components/admin/nodes";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminNodePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useT().admin.nodes;
  useDocumentTitle(t.docTitle);
  return (
    <div className="space-y-4">
      <Link href="/admin/nodes" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {t.back}
      </Link>
      <NodeDetail id={Number(id)} onDeleted={() => router.push("/admin/nodes")} />
    </div>
  );
}
