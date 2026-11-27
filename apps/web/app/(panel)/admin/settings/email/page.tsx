"use client";
import { PageHeader } from "@/app/_components/page-header";
import { SmtpSettingsCard } from "@/app/_components/admin/smtp-settings";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function EmailSettingsPage() {
  const t = useT().notif2;
  useDocumentTitle(t.smtpTitle);
  return (
    <>
      <PageHeader title={t.smtpTitle} description={t.smtpText} />
      <div className="max-w-2xl">
        <SmtpSettingsCard />
      </div>
    </>
  );
}
