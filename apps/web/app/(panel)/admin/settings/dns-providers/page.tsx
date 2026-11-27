"use client";
import { PageHeader } from "@/app/_components/page-header";
import { DnsProvidersAdmin, SettingsTabs } from "@/app/_components/admin/settings";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function DnsProvidersAdminPage() {
  const d = useT().admin2.dns;
  useDocumentTitle(d.docTitle);
  return (
    <>
      <PageHeader title={d.title} description={d.description} />
      <SettingsTabs current="dns" />
      <DnsProvidersAdmin />
    </>
  );
}
