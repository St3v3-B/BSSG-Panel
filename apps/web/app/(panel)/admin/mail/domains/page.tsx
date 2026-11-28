"use client";
import { Plus } from "lucide-react";
import Link from "next/link";
import { MailDomainList } from "@/app/_components/mail/domains";
import { PageHeader } from "@/app/_components/page-header";
import { Button } from "@/app/_components/ui/button";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminMailDomainsPage() {
  const t = useT().mail.domains;
  useDocumentTitle(t.docTitle);
  return (
    <>
      <PageHeader
        title={t.title}
        description={t.description}
        actions={
          <Button asChild>
            <Link href="/admin/mail/domains/new" data-testid="mail-domain-add">
              <Plus /> {t.add}
            </Link>
          </Button>
        }
      />
      <MailDomainList />
    </>
  );
}
