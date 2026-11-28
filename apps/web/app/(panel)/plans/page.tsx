"use client";
import { PlanPicker } from "@/app/_components/billing/plan-picker";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function PlansPage() {
  const t = useT().billing.plans;
  useDocumentTitle(t.title);
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <PlanPicker />
    </>
  );
}
