"use client";
import type { InvoiceStatus, SubscriptionStatus } from "@panel/api";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { AdminError, Field } from "@/app/_components/admin/nodes";
import { formatDay, formatMoney, InvoiceBadge, PriceText, SubscriptionBadge } from "@/app/_components/billing/common";
import { QueryError } from "@/app/_components/query-error";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { Table } from "@/app/_components/ui/table";
import { useT } from "@/app/_lib/i18n";

const SUB_STATUSES: SubscriptionStatus[] = ["pending", "active", "past_due", "suspended", "canceled"];
const INV_STATUSES: InvoiceStatus[] = ["open", "overdue", "paid", "void"];

function GrantForm({ onDone }: { onDone: () => void }) {
  const all = useT();
  const t = all.billing.admin;
  const router = useRouter();
  const utils = trpc.useUtils();
  const users = trpc.admin.users.list.useQuery({ limit: 100 });
  const plans = trpc.admin.plans.list.useQuery();
  const [userId, setUserId] = useState<number | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [name, setName] = useState("");
  const grant = trpc.admin.subscriptions.grant.useMutation({
    onSuccess: async (r) => {
      await utils.admin.subscriptions.list.invalidate();
      onDone();
      router.push(`/servers/${r.serverUuid}`);
    },
  });
  const plan = plans.data?.find((p) => p.id === (planId ?? plans.data?.[0]?.id));
  const uid = userId ?? users.data?.items[0]?.id ?? null;
  const tpl = templateId ?? plan?.templates[0]?.id ?? null;
  const valid = uid !== null && !!plan && tpl !== null && !!name.trim();
  return (
    <Card data-testid="grant-form">
      <CardHeader>
        <CardTitle className="text-base">{t.grantTitle}</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) grant.mutate({ userId: uid!, planId: plan!.id, templateId: tpl!, name: name.trim(), variables: {} });
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="grant-user" label={t.grantUser}>
              <Select id="grant-user" value={uid ?? ""} onChange={(e) => setUserId(Number(e.target.value))}>
                {(users.data?.items ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name ?? u.discordId}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="grant-plan" label={all.billing.page.plan}>
              <Select id="grant-plan" value={plan?.id ?? ""} onChange={(e) => (setPlanId(Number(e.target.value)), setTemplateId(null))}>
                {(plans.data ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="grant-template" label={all.billing.plans.template}>
              <Select id="grant-template" value={tpl ?? ""} onChange={(e) => setTemplateId(Number(e.target.value))}>
                {(plan?.templates ?? []).map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field id="grant-name" label={all.billing.plans.name}>
              <Input id="grant-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          {grant.error && <AdminError error={grant.error} />}
          <div className="flex gap-2">
            <Button type="submit" disabled={!valid || grant.isPending}>
              {grant.isPending && <Spinner />} {t.grantSubmit}
            </Button>
            <Button type="button" variant="ghost" onClick={onDone}>
              {all.common.cancel}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function SubscriptionsTab() {
  const all = useT();
  const t = all.billing.admin;
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<SubscriptionStatus | "">("");
  const [granting, setGranting] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  const list = trpc.admin.subscriptions.list.useInfiniteQuery({ limit: 50, status: status || undefined }, { getNextPageParam: (p) => p.nextCursor });
  const cancel = trpc.admin.subscriptions.cancel.useMutation({ onSuccess: () => (setConfirm(null), void utils.admin.subscriptions.list.invalidate()) });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <Select aria-label={t.allStatuses} value={status} onChange={(e) => setStatus(e.target.value as SubscriptionStatus | "")} className="w-auto">
          <option value="">{t.allStatuses}</option>
          {SUB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {all.billing.status[s]}
            </option>
          ))}
        </Select>
        {!granting && <Button onClick={() => setGranting(true)}>{t.grant}</Button>}
      </div>
      {granting && <GrantForm onDone={() => setGranting(false)} />}
      {cancel.error && <AdminError error={cancel.error} />}
      {list.error ? (
        <QueryError error={list.error} />
      ) : !list.data ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.none}</p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table data-testid="admin-subscriptions">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="p-3 font-medium">{t.user}</th>
                  <th className="p-3 font-medium">{all.billing.page.plan}</th>
                  <th className="p-3 font-medium">{all.billing.page.server}</th>
                  <th className="p-3 font-medium">{all.billing.page.price}</th>
                  <th className="p-3 font-medium">{all.billing.page.status}</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {items.map((s) => (
                  <tr key={s.id} className="border-b border-border last:border-0">
                    <td className="p-3">
                      <Link className="hover:underline" href={`/admin/users/${s.user.id}`}>
                        {s.user.name ?? s.user.discordId}
                      </Link>
                    </td>
                    <td className="p-3">
                      {s.plan.name} {s.free && s.priceCents === 0 && <Badge variant="outline">{t.granted}</Badge>}
                    </td>
                    <td className="p-3">{s.server ? <Link className="hover:underline" href={`/admin/servers/${s.server.uuid}`}>{s.server.name}</Link> : "–"}</td>
                    <td className="p-3">
                      <PriceText cents={s.priceCents} currency={s.currency} />
                    </td>
                    <td className="p-3">
                      <SubscriptionBadge status={s.status} />
                      {s.cancelAtPeriodEnd && s.status !== "canceled" && <div className="text-xs text-muted-foreground">{all.billing.page.endsOn(formatDay(s.currentPeriodEnd))}</div>}
                    </td>
                    <td className="p-3 text-right">
                      {s.status !== "canceled" &&
                        (confirm === s.id ? (
                          <div className="flex flex-wrap justify-end gap-2">
                            <Button size="sm" variant="outline" onClick={() => cancel.mutate({ id: s.id, deleteServer: false })} disabled={cancel.isPending}>
                              {t.endNow}
                            </Button>
                            <Button size="sm" variant="destructive" onClick={() => cancel.mutate({ id: s.id, deleteServer: true })} disabled={cancel.isPending}>
                              {t.endDelete}
                            </Button>
                          </div>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => setConfirm(s.id)}>
                            {t.endNow}
                          </Button>
                        ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      )}
      {list.hasNextPage && (
        <Button variant="outline" size="sm" onClick={() => void list.fetchNextPage()}>
          {all.common.loadMore}
        </Button>
      )}
    </div>
  );
}

function InvoicesTab() {
  const all = useT();
  const t = all.billing.admin;
  const utils = trpc.useUtils();
  const [status, setStatus] = useState<InvoiceStatus | "">("");
  const list = trpc.admin.invoices.list.useInfiniteQuery({ limit: 50, status: status || undefined }, { getNextPageParam: (p) => p.nextCursor });
  const inv = () => (void utils.admin.invoices.list.invalidate(), void utils.admin.subscriptions.list.invalidate());
  const markPaid = trpc.admin.invoices.markPaid.useMutation({ onSuccess: inv });
  const voidIt = trpc.admin.invoices.void.useMutation({ onSuccess: inv });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-4">
      <Select aria-label={t.allStatuses} value={status} onChange={(e) => setStatus(e.target.value as InvoiceStatus | "")} className="w-auto">
        <option value="">{t.allStatuses}</option>
        {INV_STATUSES.map((s) => (
          <option key={s} value={s}>
            {all.billing.invoiceStatus[s]}
          </option>
        ))}
      </Select>
      {(markPaid.error ?? voidIt.error) && <AdminError error={markPaid.error ?? voidIt.error} />}
      {list.error ? (
        <QueryError error={list.error} />
      ) : !list.data ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.none}</p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table data-testid="admin-invoices">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="p-3 font-medium">{all.billing.page.number}</th>
                  <th className="p-3 font-medium">{t.user}</th>
                  <th className="p-3 font-medium">{all.billing.page.date}</th>
                  <th className="p-3 font-medium">{all.billing.page.amount}</th>
                  <th className="p-3 font-medium">{all.billing.page.status}</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="border-b border-border last:border-0" data-testid="admin-invoice-row">
                    <td className="p-3 font-mono text-xs">
                      <Link className="hover:underline" href={`/billing/invoices/${i.id}`}>
                        {i.number}
                      </Link>
                    </td>
                    <td className="p-3">{i.user.name ?? i.user.discordId}</td>
                    <td className="p-3">{formatDay(i.issuedAt)}</td>
                    <td className="p-3">{formatMoney(i.amountCents, i.currency)}</td>
                    <td className="p-3">
                      <InvoiceBadge status={i.status} />
                    </td>
                    <td className="p-3 text-right">
                      {(i.status === "open" || i.status === "overdue") && (
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button size="sm" variant="outline" onClick={() => markPaid.mutate({ id: i.id })} disabled={markPaid.isPending}>
                            {t.markPaid}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => voidIt.mutate({ id: i.id })} disabled={voidIt.isPending}>
                            {t.void}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      )}
      {list.hasNextPage && (
        <Button variant="outline" size="sm" onClick={() => void list.fetchNextPage()}>
          {all.common.loadMore}
        </Button>
      )}
    </div>
  );
}

/** Admin → Facturatie: abonnementen en facturen. */
export function BillingAdmin() {
  const t = useT().billing.admin;
  const [tab, setTab] = useState<"subs" | "invoices">("subs");
  return (
    <div className="space-y-4">
      <div role="tablist" className="flex gap-1 rounded-lg border border-border p-1 w-fit">
        {(["subs", "invoices"] as const).map((k) => (
          <Button key={k} role="tab" aria-selected={tab === k} size="sm" variant={tab === k ? "default" : "ghost"} onClick={() => setTab(k)}>
            {k === "subs" ? t.tabSubscriptions : t.tabInvoices}
          </Button>
        ))}
      </div>
      {tab === "subs" ? <SubscriptionsTab /> : <InvoicesTab />}
    </div>
  );
}
