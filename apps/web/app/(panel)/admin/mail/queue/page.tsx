"use client";
import { MailQueue } from "@/app/_components/mail/queue";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminMailQueuePage() {
  const t = useT().mail.queue;
  useDocumentTitle(t.docTitle);
  return (
    <>
      <PageHeader title={t.title} description={t.description} />
      <MailQueue />
    </>
  );
}
