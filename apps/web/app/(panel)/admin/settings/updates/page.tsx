"use client";
import { PageHeader } from "@/app/_components/page-header";
import { UpdatesAdmin } from "@/app/_components/updates";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function UpdatesAdminPage() {
  const d = useT().updates;
  useDocumentTitle(d.docTitle);
  return (
    <>
      <PageHeader title={d.pageTitle} description={d.pageDescription} />
      <UpdatesAdmin />
    </>
  );
}
