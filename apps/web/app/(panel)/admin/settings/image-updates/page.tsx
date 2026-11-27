"use client";
import { PageHeader } from "@/app/_components/page-header";
import { SettingsTabs } from "@/app/_components/admin/settings";
import { ImageUpdatesAdmin } from "@/app/_components/image-updates";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function ImageUpdatesAdminPage() {
  const d = useT().imageUpdates;
  useDocumentTitle(d.docTitle);
  return (
    <>
      <PageHeader title={d.pageTitle} description={d.pageDescription} />
      <SettingsTabs current="images" />
      <ImageUpdatesAdmin />
    </>
  );
}
