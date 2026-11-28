"use client";
import { ApiDocs } from "@/app/_components/developers/api-docs";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function DevelopersPage() {
  const t = useT();
  useDocumentTitle(t.devaccess.developers.title);
  return <ApiDocs />;
}
