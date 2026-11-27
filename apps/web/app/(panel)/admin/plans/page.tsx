"use client";
import { PlansAdmin } from "@/app/_components/admin/billing-plans";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminPlansPage() {
  const t = useT().billing.admin;
  useDocumentTitle(t.plansTitle);
  return (
    <>
      <PageHeader title={t.plansTitle} description={t.plansDescription} />
      <PlansAdmin />
    </>
  );
}
