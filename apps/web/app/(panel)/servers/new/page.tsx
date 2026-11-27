"use client";
import { NewServerForm } from "@/app/_components/quota/new-server-form";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function NewServerPage() {
  const t = useT().quota;
  useDocumentTitle(t.newServer);
  return (
    <>
      <PageHeader title={t.newServer} />
      <NewServerForm />
    </>
  );
}
