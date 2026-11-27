"use client";
import { UsersAdmin } from "@/app/_components/admin/users";
import { QuotaUsageTable } from "@/app/_components/quota/quota-usage";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminUsersPage() {
  const t = useT().admin.users;
  useDocumentTitle(t.docTitle);
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <UsersAdmin />
      <div className="mt-6">
        <QuotaUsageTable />
      </div>
    </>
  );
}
