"use client";
import { useParams } from "next/navigation";
import { InvoiceView } from "@/app/_components/billing/invoice-view";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  useDocumentTitle(useT().billing.page.invoices);
  return <InvoiceView id={Number(id)} />;
}
