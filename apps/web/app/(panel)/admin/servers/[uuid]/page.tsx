"use client";
import { useParams } from "next/navigation";
import { AdminServerPage } from "@/app/_components/admin/server-manage";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminServerDetailPage() {
  const { uuid } = useParams<{ uuid: string }>();
  useDocumentTitle(useT().admin2.server.docTitle);
  return <AdminServerPage uuid={uuid} />;
}
