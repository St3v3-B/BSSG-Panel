"use client";
import type { InvoiceStatus, SubscriptionStatus } from "@panel/api";
import { Badge, type BadgeVariant } from "@/app/_components/ui/badge";
import { intlLocale, useT } from "@/app/_lib/i18n";
import { formatMb } from "@/app/_lib/format";

/** Bedrag in centen als valuta in de taal van het panel. */
export function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(intlLocale(), { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Alleen de datum (zonder tijd), Europe/Amsterdam. */
export function formatDay(d: Date | null | undefined): string {
  if (!d) return "–";
  return new Intl.DateTimeFormat(intlLocale(), { dateStyle: "medium", timeZone: "Europe/Amsterdam" }).format(d);
}

const SUB_VARIANT: Record<SubscriptionStatus, BadgeVariant> = { pending: "warning", active: "success", past_due: "warning", suspended: "destructive", canceled: "secondary" };
const INV_VARIANT: Record<InvoiceStatus, BadgeVariant> = { open: "info", paid: "success", overdue: "destructive", void: "secondary" };

export function SubscriptionBadge({ status }: { status: SubscriptionStatus }) {
  const t = useT().billing;
  return (
    <Badge variant={SUB_VARIANT[status]} data-testid="subscription-status">
      {t.status[status]}
    </Badge>
  );
}

export function InvoiceBadge({ status }: { status: InvoiceStatus }) {
  const t = useT().billing;
  return (
    <Badge variant={INV_VARIANT[status]} data-testid="invoice-status">
      {t.invoiceStatus[status]}
    </Badge>
  );
}

export function PriceText({ cents, currency }: { cents: number; currency: string }) {
  const t = useT().billing;
  return <>{cents > 0 ? t.perMonth(formatMoney(cents, currency)) : t.free}</>;
}

export const mb = (n: number) => formatMb(n);
