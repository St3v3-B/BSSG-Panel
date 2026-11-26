"use client";
import { NodesAdmin } from "@/app/_components/admin/nodes";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminNodesPage() {
  const t = useT().admin.nodes;
  useDocumentTitle(t.docTitle);
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <NodesAdmin />
    </>
  );
}
