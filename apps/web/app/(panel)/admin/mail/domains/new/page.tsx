"use client";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { DomainWizard } from "@/app/_components/mail/domains";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminMailDomainNewPage() {
  const t = useT().mail;
  useDocumentTitle(t.wizard.docTitle);
  return (
    <div className="space-y-4">
      <div className="mx-auto max-w-3xl">
        <Link href="/admin/mail/domains" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> {t.detail.back}
        </Link>
        <PageHeader className="mb-0 mt-3 sm:mb-0" title={t.wizard.title} description={t.wizard.description} />
      </div>
      <DomainWizard />
    </div>
  );
}
