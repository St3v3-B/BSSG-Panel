"use client";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CreateServerForm } from "@/app/_components/create-server-form";
import { PageHeader } from "@/app/_components/page-header";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";

export default function NewServerPage() {
  useDocumentTitle("Admin · server aanmaken");
  const router = useRouter();
  return (
    <div className="mx-auto max-w-4xl">
      <Link href="/admin" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Alle servers
      </Link>
      <PageHeader title="Server aanmaken" description="Maak een game-server of website aan voor een gebruiker. De installatie start direct." />
      <CreateServerForm onCreated={(s) => router.push(`/servers/${s.uuid}`)} />
    </div>
  );
}
