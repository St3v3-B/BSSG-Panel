"use client";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { TemplateEditor } from "@/app/_components/admin/templates";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";

/** /admin/templates/new of /admin/templates/<id>. */
export default function AdminTemplatePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const t = useT().admin.templates;
  useDocumentTitle(t.docTitle);
  const numeric = id === "new" ? null : Number(id);
  return (
    <div className="space-y-4">
      <Link href="/admin/templates" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {t.back}
      </Link>
      <TemplateEditor
        key={id}
        id={numeric}
        onCreated={(tpl) => router.replace(`/admin/templates/${tpl.id}`)}
        onDeleted={() => router.push("/admin/templates")}
      />
    </div>
  );
}
