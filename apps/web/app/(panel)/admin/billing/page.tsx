"use client";
import { BillingAdmin } from "@/app/_components/admin/billing-admin";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminBillingPage() {
  const t = useT().billing.admin;
  useDocumentTitle(t.billingTitle);
  return (
    <>
      <PageHeader title={t.billingTitle} description={t.billingDescription} />
      <BillingAdmin />
    </>
  );
}
