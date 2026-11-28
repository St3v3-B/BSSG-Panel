"use client";
import { Suspense } from "react";
import { BillingOverview } from "@/app/_components/billing/billing-overview";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function BillingPage() {
  const t = useT().billing.page;
  useDocumentTitle(t.title);
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      {/* useSearchParams (?paid=…) vereist een Suspense-grens */}
      <Suspense>
        <BillingOverview />
      </Suspense>
    </>
  );
}
