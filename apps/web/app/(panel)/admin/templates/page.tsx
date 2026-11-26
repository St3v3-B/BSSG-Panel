"use client";
import { TemplatesAdmin } from "@/app/_components/admin/templates";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminTemplatesPage() {
  const t = useT().admin.templates;
  useDocumentTitle(t.docTitle);
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <TemplatesAdmin />
    </>
  );
}
