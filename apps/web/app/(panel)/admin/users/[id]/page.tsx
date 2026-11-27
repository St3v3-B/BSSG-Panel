"use client";
import { useParams } from "next/navigation";
import { UserDetail } from "@/app/_components/admin/user-detail";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

export default function AdminUserPage() {
  const { id } = useParams<{ id: string }>();
  useDocumentTitle(useT().admin2.user.docTitle);
  return <UserDetail id={Number(id)} />;
}
