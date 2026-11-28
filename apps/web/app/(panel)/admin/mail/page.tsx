"use client";
import { Globe } from "lucide-react";
import Link from "next/link";
import { MailOverview } from "@/app/_components/mail/overview";
import { PageHeader } from "@/app/_components/page-header";
import { Button } from "@/app/_components/ui/button";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminMailPage() {
  const t = useT().mail.overview;
  useDocumentTitle(t.docTitle);
  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <Button asChild variant="outline">
            <Link href="/admin/mail/domains">
              <Globe /> {t.manageDomains}
            </Link>
          </Button>
        }
      />
      <MailOverview />
    </>
  );
}
