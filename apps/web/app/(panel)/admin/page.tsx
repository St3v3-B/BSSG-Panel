"use client";
import { AdminDashboard } from "@/app/_components/admin/dashboard";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminDashboardPage() {
  const d = useT().admin2.dashboard;
  useDocumentTitle(d.docTitle);
  return (
    <>
      <PageHeader title={d.title} description={d.description} />
      <AdminDashboard />
    </>
  );
}
