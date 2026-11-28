"use client";
import { BillingSettingsAdmin } from "@/app/_components/admin/billing-settings";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminBillingSettingsPage() {
  const t = useT().billing.settings;
  useDocumentTitle(t.title);
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <BillingSettingsAdmin />
    </>
  );
}
