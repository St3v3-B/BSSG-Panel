"use client";
import { PageHeader } from "@/app/_components/page-header";
import { StatusPagesManager } from "@/app/_components/status/status-page-settings";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function StatusPagesPage() {
  const t = useT().statusPage;
  useDocumentTitle(t.docTitle);
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t.navTitle} description={t.pageText} />
      <StatusPagesManager />
    </div>
  );
}
