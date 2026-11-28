"use client";
import { ImporterAdmin } from "@/app/_components/admin/importer";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminImportPage() {
  const t = useT().hostops.imp;
  useDocumentTitle(t.docTitle);
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <ImporterAdmin />
    </>
  );
}
