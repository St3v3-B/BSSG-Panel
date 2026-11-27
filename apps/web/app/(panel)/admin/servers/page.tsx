"use client";
import { AdminServersList, CreateServerButton } from "@/app/_components/admin/servers-list";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminServersPage() {
  const l = useT().admin2.list;
  useDocumentTitle(l.docTitle);
  return (
    <>
      <PageHeader title={l.title} description={l.description} actions={<CreateServerButton />} />
      <AdminServersList />
    </>
  );
}
