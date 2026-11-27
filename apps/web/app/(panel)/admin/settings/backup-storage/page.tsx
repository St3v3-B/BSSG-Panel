"use client";
import { PageHeader } from "@/app/_components/page-header";
import { S3TargetsAdmin, SettingsTabs } from "@/app/_components/admin/settings";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function BackupStorageAdminPage() {
  const d = useT().admin2.s3;
  useDocumentTitle(d.docTitle);
  return (
    <>
      <PageHeader title={d.title} description={d.description} />
      <SettingsTabs current="s3" />
      <S3TargetsAdmin />
    </>
  );
}
