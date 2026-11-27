"use client";
import { useParams } from "next/navigation";
import { BrandMark } from "@/app/_components/branding";
import { LocaleSwitcher } from "@/app/_components/locale-switcher";
import { PublicStatusView } from "@/app/_components/status/public-status";
import { ThemeToggle } from "@/app/_components/theme";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { useT } from "@/app/_lib/i18n";
import { trpc } from "@/lib/trpc";

/** Openbare statuspagina: geen login, ververst elke 30 s (het panel cachet het antwoord). */
export default function StatusPage() {
  const { slug } = useParams<{ slug: string }>();
  const t = useT().statusPage.public;
  const q = trpc.statusPages.public.useQuery({ slug: String(slug ?? "") }, { refetchInterval: 30_000, retry: (n, e) => e.data?.code !== "NOT_FOUND" && n < 2 });
  const branding = trpc.auth.branding.useQuery(undefined, { staleTime: 60_000 });
  useDocumentTitle(q.data?.title ?? null);
  return (
    <div className="relative min-h-dvh px-4 py-6 sm:py-10">
      <div className="mx-auto w-full max-w-3xl space-y-8">
        <div className="flex items-center justify-between gap-3">
          <BrandMark />
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LocaleSwitcher />
          </div>
        </div>
        {q.data ? (
          <PublicStatusView status={q.data} />
        ) : q.error ? (
          <p className="py-16 text-center text-muted-foreground" role="alert">
            {t.notFound}
          </p>
        ) : (
          <div className="space-y-4">
            <Skeleton className="h-12 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
          </div>
        )}
        {branding.data && <p className="text-center text-xs text-muted-foreground">{t.poweredBy(branding.data.panelName)}</p>}
      </div>
    </div>
  );
}
