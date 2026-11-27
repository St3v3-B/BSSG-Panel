"use client";
import type { ServerSummary } from "@panel/api";
import { ArrowLeft, Ban, Printer } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { formatDay, formatMoney, InvoiceBadge } from "@/app/_components/billing/common";
import { go } from "@/app/_components/billing/plan-picker";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

/** Nette, printbare factuur (Afdrukken → Opslaan als pdf). De knoppen verdwijnen bij het afdrukken. */
export function InvoiceView({ id }: { id: number }) {
  const all = useT();
  const t = all.billing.invoice;
  const router = useRouter();
  const q = trpc.billing.invoice.useQuery({ id });
  const pay = trpc.billing.pay.useMutation({ onSuccess: (r) => go(router, r.url) });
  if (q.error) return <QueryError error={q.error} />;
  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  const i = q.data;
  const total = i.lines.reduce((a, l) => a + l.totalCents, 0);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button variant="ghost" size="sm" onClick={() => router.back()}>
          <ArrowLeft /> {t.back}
        </Button>
        <Button variant="outline" size="sm" onClick={() => window.print()}>
          <Printer /> {t.print}
        </Button>
        {i.canPay && (
          <Button size="sm" onClick={() => pay.mutate({ invoiceId: i.id })} disabled={pay.isPending}>
            {all.billing.page.pay}
          </Button>
        )}
      </div>
      {pay.error && <p className="text-sm text-destructive print:hidden">{errorText(pay.error)}</p>}
      <article
        className="invoice-print mx-auto max-w-3xl rounded-xl border border-border bg-white p-8 text-neutral-900 shadow-card print:max-w-none print:border-0 print:p-0 print:shadow-none"
        data-testid="invoice"
      >
        <header className="flex flex-wrap items-start justify-between gap-6 border-b border-neutral-200 pb-6">
          <div>
            <h1 className="text-2xl font-bold">{t.title(i.number)}</h1>
            <div className="mt-2">
              <InvoiceBadge status={i.status} />
              {i.paidAt && <span className="ml-2 text-sm text-neutral-600">{t.paidOn(formatDay(i.paidAt))}</span>}
            </div>
          </div>
          <div className="text-right text-sm">
            <div className="text-xs uppercase tracking-wide text-neutral-500">{t.from}</div>
            <div className="font-semibold">{i.issuer.name || "–"}</div>
            <div className="whitespace-pre-line text-neutral-700">{i.issuer.address}</div>
            {i.issuer.email && <div className="text-neutral-700">{i.issuer.email}</div>}
            {i.issuer.vatId && <div className="text-neutral-700">{t.vat(i.issuer.vatId)}</div>}
          </div>
        </header>
        <section className="grid gap-4 py-6 text-sm sm:grid-cols-3">
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">{t.to}</div>
            <div className="font-semibold">{i.customer.name ?? "–"}</div>
            {i.customer.discordId && <div className="font-mono text-xs text-neutral-600">Discord {i.customer.discordId}</div>}
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-neutral-500">{t.issued}</div>
            <div>{formatDay(i.issuedAt)}</div>
            <div className="mt-2 text-xs uppercase tracking-wide text-neutral-500">{t.due}</div>
            <div>{formatDay(i.dueAt)}</div>
          </div>
          {i.periodStart && (
            <div>
              <div className="text-xs uppercase tracking-wide text-neutral-500">{t.period}</div>
              <div>
                {formatDay(i.periodStart)} – {formatDay(i.periodEnd)}
              </div>
            </div>
          )}
        </section>
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-neutral-300 text-left text-neutral-600">
              <th className="py-2 font-medium">{t.description}</th>
              <th className="py-2 text-right font-medium">{t.qty}</th>
              <th className="py-2 text-right font-medium">{t.unit}</th>
              <th className="py-2 text-right font-medium">{t.total}</th>
            </tr>
          </thead>
          <tbody>
            {i.lines.map((l, n) => (
              <tr key={n} className="border-b border-neutral-200">
                <td className="py-2">{l.description}</td>
                <td className="py-2 text-right">{l.quantity}</td>
                <td className="py-2 text-right">{formatMoney(l.unitCents, i.currency)}</td>
                <td className="py-2 text-right">{formatMoney(l.totalCents, i.currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} className="pt-4 text-right font-semibold">
                {t.total}
              </td>
              <td className="pt-4 text-right text-lg font-bold" data-testid="invoice-total">
                {formatMoney(total, i.currency)}
              </td>
            </tr>
          </tfoot>
        </table>
        {i.issuer.footer && <footer className="mt-10 whitespace-pre-line border-t border-neutral-200 pt-4 text-xs text-neutral-500">{i.issuer.footer}</footer>}
      </article>
    </div>
  );
}

/** Melding op de serverpagina als de facturatie de server heeft opgeschort. */
export function BillingSuspendedNotice({ suspended }: { suspended: ServerSummary["suspended"] }) {
  const t = useT().billing.suspended;
  const reason = suspended?.reason;
  if (reason !== "BILLING_UNPAID" && reason !== "BILLING_OVERDUE" && reason !== "SUBSCRIPTION_ENDED") return null;
  return (
    <Alert variant="warning" data-testid="billing-suspended">
      <Ban />
      <div>
        <AlertDescription>{t[reason]}</AlertDescription>
      </div>
      {reason !== "SUBSCRIPTION_ENDED" && (
        <Button asChild size="sm" variant="outline">
          <Link href="/billing">{t.toBilling}</Link>
        </Button>
      )}
    </Alert>
  );
}
