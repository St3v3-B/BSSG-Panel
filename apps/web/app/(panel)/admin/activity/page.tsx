"use client";
import { ActivityAdmin } from "@/app/_components/admin/activity";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminActivityPage() {
  const t = useT().admin.activity;
  useDocumentTitle(t.docTitle);
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <ActivityAdmin />
    </>
  );
}
