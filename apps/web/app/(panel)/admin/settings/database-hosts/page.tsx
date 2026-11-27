"use client";
import { PageHeader } from "@/app/_components/page-header";
import { DatabaseHostsAdmin, SettingsTabs } from "@/app/_components/admin/settings";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function DatabaseHostsAdminPage() {
  const d = useT().admin2.dbHosts;
  useDocumentTitle(d.docTitle);
  return (
    <>
      <PageHeader title={d.title} description={d.description} />
      <SettingsTabs current="db" />
      <DatabaseHostsAdmin />
    </>
  );
}
