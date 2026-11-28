"use client";
import { useParams } from "next/navigation";
import { MailDomainDetailView } from "@/app/_components/mail/domain-detail";

export default function AdminMailDomainPage() {
  const { id } = useParams<{ id: string }>();
  return <MailDomainDetailView id={Number(id)} />;
}
