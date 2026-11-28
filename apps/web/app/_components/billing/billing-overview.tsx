"use client";
import type { Subscription } from "@panel/api";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { formatDay, formatMoney, InvoiceBadge, PriceText, SubscriptionBadge } from "@/app/_components/billing/common";
import { go } from "@/app/_components/billing/plan-picker";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { Table } from "@/app/_components/ui/table";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

function SubscriptionRow({ s }: { s: Subscription }) {
  const all = useT();
  const t = all.billing.page;
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState(false);
  const [del, setDel] = useState(false);
  const [typed, setTyped] = useState("");
  const done = () => (setConfirm(false), void utils.billing.invalidate(), void utils.servers.list.invalidate());
  const cancel = trpc.billing.cancel.useMutation({ onSuccess: done });
  const resume = trpc.billing.resume.useMutation({ onSuccess: done });
  const immediate = s.free || s.status === "pending";
  const err = cancel.error ?? resume.error;
  return (
    <Card className="p-4" data-testid="subscription">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2 font-medium">
            {s.plan.name} <SubscriptionBadge status={s.status} />
            {s.cancelAtPeriodEnd && s.status !== "canceled" && <Badge variant="warning">{t.endsOn(formatDay(s.currentPeriodEnd))}</Badge>}
          </div>
          <div className="text-sm text-muted-foreground">
            {s.server ? (
              <Link className="underline-offset-2 hover:underline" href={`/servers/${s.server.uuid}`}>
                {s.server.name}
              </Link>
            ) : (
              "–"
            )}
            {" · "}
            <PriceText cents={s.priceCents} currency={s.currency} />
          </div>
          {s.status !== "canceled" && !s.cancelAtPeriodEnd && s.currentPeriodEnd && <div className="text-xs text-muted-foreground">{t.renews(formatDay(s.currentPeriodEnd))}</div>}
          {s.pastDueSince && s.status !== "canceled" && <div className="text-xs text-destructive">{t.pastDueSince(formatDay(s.pastDueSince))}</div>}
        </div>
        {s.status !== "canceled" && (
          <div className="flex flex-wrap gap-2">
            {s.cancelAtPeriodEnd ? (
              <Button size="sm" variant="outline" onClick={() => resume.mutate({ id: s.id })} disabled={resume.isPending}>
                {t.resume}
              </Button>
            ) : (
              !confirm && (
                <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>
                  {t.cancel}
                </Button>
              )
            )}
          </div>
        )}
      </div>
      {confirm && (
        <div className="mt-3 space-y-3 rounded-lg border border-border p-3" data-testid="cancel-confirm">
          <p className="text-sm">{immediate ? t.cancelFreeConfirm : t.cancelConfirm}</p>
          {immediate && s.server && (
            <>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={del} onChange={(e) => setDel(e.target.checked)} /> {t.deleteServerToo}
              </label>
              {del && <Input aria-label={t.confirmName(s.server.name)} placeholder={t.confirmName(s.server.name)} value={typed} onChange={(e) => setTyped(e.target.value)} />}
            </>
          )}
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={cancel.isPending || (del && typed !== s.server?.name)} onClick={() => cancel.mutate({ id: s.id, deleteServer: del, confirmName: del ? typed : undefined })}>
              {cancel.isPending && <Spinner />} {t.confirmCancel}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
              {all.common.cancel}
            </Button>
          </div>
        </div>
      )}
      {err && <p className="mt-2 text-sm text-destructive">{errorText(err)}</p>}
    </Card>
  );
}

/** Pagina Facturatie: abonnementen (opzeggen/verlengen) en facturen (bekijken/betalen). */
export function BillingOverview() {
  const all = useT();
  const t = all.billing.page;
  const router = useRouter();
  const params = useSearchParams();
  const status = trpc.billing.status.useQuery();
  const subs = trpc.billing.subscriptions.useQuery();
  const invoices = trpc.billing.invoices.useInfiniteQuery({ limit: 50 }, { getNextPageParam: (p) => p.nextCursor });
  const pay = trpc.billing.pay.useMutation({ onSuccess: (r) => go(router, r.url) });
  const items = invoices.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-6">
      {params?.get("paid") && (
        <Alert variant="info" role="status">
          <AlertDescription>{t.paidReturn}</AlertDescription>
        </Alert>
      )}
      {params?.get("canceled") && (
        <Alert variant="info" role="status">
          <AlertDescription>{t.canceledReturn}</AlertDescription>
        </Alert>
      )}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">{t.subscriptions}</h2>
          {status.data?.canSubscribe && (
            <Button asChild size="sm" variant="outline">
              <Link href="/plans">{t.newPlan}</Link>
            </Button>
          )}
        </div>
        {subs.error ? (
          <QueryError error={subs.error} />
        ) : !subs.data ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : subs.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noSubscriptions}</p>
        ) : (
          <div className="grid gap-3" data-testid="subscription-list">
            {subs.data.map((s) => (
              <SubscriptionRow key={s.id} s={s} />
            ))}
          </div>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">{t.invoices}</h2>
        {pay.error && <p className="text-sm text-destructive">{errorText(pay.error)}</p>}
        {invoices.error ? (
          <QueryError error={invoices.error} />
        ) : !invoices.data ? (
          <Skeleton className="h-24 rounded-xl" />
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.noInvoices}</p>
        ) : (
          <Card>
            <CardHeader className="sr-only">
              <CardTitle>{t.invoices}</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <Table data-testid="invoice-table">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="p-3 font-medium">{t.number}</th>
                    <th className="p-3 font-medium">{t.date}</th>
                    <th className="p-3 font-medium">{t.amount}</th>
                    <th className="p-3 font-medium">{t.status}</th>
                    <th className="p-3" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} className="border-b border-border last:border-0" data-testid="invoice-row">
                      <td className="p-3 font-mono text-xs">{i.number}</td>
                      <td className="p-3">{formatDay(i.issuedAt)}</td>
                      <td className="p-3">{formatMoney(i.amountCents, i.currency)}</td>
                      <td className="p-3">
                        <InvoiceBadge status={i.status} />
                      </td>
                      <td className="p-3 text-right">
                        <div className="flex justify-end gap-2">
                          <Button asChild size="sm" variant="ghost">
                            <Link href={`/billing/invoices/${i.id}`}>{t.view}</Link>
                          </Button>
                          {(i.status === "open" || i.status === "overdue") && status.data?.billingEnabled && (
                            <Button size="sm" onClick={() => pay.mutate({ invoiceId: i.id })} disabled={pay.isPending}>
                              {t.pay}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </CardContent>
          </Card>
        )}
        {invoices.hasNextPage && (
          <Button variant="outline" size="sm" onClick={() => void invoices.fetchNextPage()}>
            {all.common.loadMore}
          </Button>
        )}
      </section>
    </div>
  );
}
