"use client";
import type { BillingSettings, BillingSettingsInput } from "@panel/api";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { AdminError, Field } from "@/app/_components/admin/nodes";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { useT } from "@/app/_lib/i18n";

type SecretKey = "stripeSecretKey" | "stripeWebhookSecret" | "mollieApiKey";

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-center gap-2 text-sm font-medium">
        <Checkbox id={id} checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
      {hint && <p className="pl-6 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Form({ initial }: { initial: BillingSettings }) {
  const all = useT();
  const t = all.billing.settings;
  const utils = trpc.useUtils();
  const [f, setF] = useState(initial);
  const [secrets, setSecrets] = useState<Partial<Record<SecretKey, string | null>>>({});
  const save = trpc.admin.billing.update.useMutation({
    onSuccess: (s) => {
      setF(s);
      setSecrets({});
      void utils.admin.billing.get.invalidate();
      void utils.billing.status.invalidate();
    },
  });
  const set = <K extends keyof BillingSettings>(k: K, v: BillingSettings[K]) => setF((x) => ({ ...x, [k]: v }));
  const issuer = (k: keyof BillingSettings["issuer"], v: string) => setF((x) => ({ ...x, issuer: { ...x.issuer, [k]: v } }));
  const status = (k: SecretKey) => (k === "mollieApiKey" ? f.mollie.apiKey : k === "stripeSecretKey" ? f.stripe.secretKey : f.stripe.webhookSecret);
  const secret = (k: SecretKey, label: string) => {
    const st = status(k);
    const cleared = secrets[k] === null;
    return (
      <Field id={`billing-${k}`} label={label} hint={cleared ? t.secretUnset : st.set ? t.secretSet(st.hint ?? "") : t.secretUnset}>
        <div className="flex gap-2">
          <Input id={`billing-${k}`} type="password" autoComplete="off" value={secrets[k] ?? ""} onChange={(e) => setSecrets((x) => ({ ...x, [k]: e.target.value }))} />
          {st.set && !cleared && (
            <Button type="button" variant="ghost" onClick={() => setSecrets((x) => ({ ...x, [k]: null }))}>
              {t.clear}
            </Button>
          )}
        </div>
      </Field>
    );
  };

  return (
    <form
      className="max-w-2xl space-y-6"
      data-testid="billing-settings"
      onSubmit={(e) => {
        e.preventDefault();
        const body: BillingSettingsInput = {
          plansEnabled: f.plansEnabled,
          freeSelfService: f.freeSelfService,
          billingEnabled: f.billingEnabled,
          provider: f.provider,
          suspendAfterDays: f.suspendAfterDays,
          deleteAfterDays: f.deleteAfterDays,
          invoicePrefix: f.invoicePrefix,
          issuer: f.issuer,
        };
        for (const [k, v] of Object.entries(secrets) as Array<[SecretKey, string | null]>) if (v === null || v.trim()) body[k] = v === null ? null : v.trim();
        save.mutate(body);
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.plansSection}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Toggle id="billing-plans" label={t.plansEnabled} hint={t.plansEnabledHint} checked={f.plansEnabled} onChange={(v) => set("plansEnabled", v)} />
          <Toggle id="billing-free" label={t.freeSelfService} hint={t.freeSelfServiceHint} checked={f.freeSelfService} onChange={(v) => set("freeSelfService", v)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.billingSection}</CardTitle>
          <CardDescription>{t.billingEnabledHint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Toggle id="billing-enabled" label={t.billingEnabled} checked={f.billingEnabled} onChange={(v) => set("billingEnabled", v)} />
          <Field id="billing-provider" label={t.provider}>
            <Select id="billing-provider" value={f.provider ?? ""} onChange={(e) => set("provider", (e.target.value || null) as BillingSettings["provider"])}>
              <option value="">{t.noProvider}</option>
              <option value="stripe">Stripe</option>
              <option value="mollie">Mollie</option>
            </Select>
          </Field>
          {f.provider === "stripe" && (
            <>
              {secret("stripeSecretKey", t.stripeSecretKey)}
              {secret("stripeWebhookSecret", t.stripeWebhookSecret)}
              <Field id="billing-stripe-url" label={t.webhookUrl} hint={t.stripeEvents}>
                <div className="flex gap-2">
                  <Input id="billing-stripe-url" readOnly value={f.webhookUrls.stripe} className="font-mono text-xs" />
                  <CopyButton value={f.webhookUrls.stripe} />
                </div>
              </Field>
            </>
          )}
          {f.provider === "mollie" && (
            <>
              {secret("mollieApiKey", t.mollieApiKey)}
              <Field id="billing-mollie-url" label={t.webhookUrl}>
                <Input id="billing-mollie-url" readOnly value={f.webhookUrls.mollie} className="font-mono text-xs" />
              </Field>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.dunningSection}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field id="billing-suspend" label={t.suspendAfterDays}>
            <Input id="billing-suspend" type="number" min={0} max={365} value={f.suspendAfterDays} onChange={(e) => set("suspendAfterDays", Number(e.target.value))} />
          </Field>
          <Toggle id="billing-delete" label={t.deleteEnabled} hint={t.deleteHint} checked={f.deleteAfterDays !== null} onChange={(v) => set("deleteAfterDays", v ? Math.max(30, f.suspendAfterDays) : null)} />
          {f.deleteAfterDays !== null && (
            <Field id="billing-delete-days" label={t.deleteAfterDays}>
              <Input id="billing-delete-days" type="number" min={1} max={3650} value={f.deleteAfterDays} onChange={(e) => set("deleteAfterDays", Number(e.target.value))} />
            </Field>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.invoiceSection}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field id="billing-prefix" label={t.invoicePrefix}>
            <Input id="billing-prefix" value={f.invoicePrefix} maxLength={12} onChange={(e) => set("invoicePrefix", e.target.value)} />
          </Field>
          <Field id="billing-issuer-name" label={t.issuerName}>
            <Input id="billing-issuer-name" value={f.issuer.name} maxLength={200} onChange={(e) => issuer("name", e.target.value)} />
          </Field>
          <Field id="billing-issuer-email" label={t.issuerEmail}>
            <Input id="billing-issuer-email" value={f.issuer.email} maxLength={200} onChange={(e) => issuer("email", e.target.value)} />
          </Field>
          <Field id="billing-issuer-vat" label={t.issuerVat}>
            <Input id="billing-issuer-vat" value={f.issuer.vatId} maxLength={50} onChange={(e) => issuer("vatId", e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field id="billing-issuer-address" label={t.issuerAddress}>
              <textarea id="billing-issuer-address" className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" maxLength={1000} value={f.issuer.address} onChange={(e) => issuer("address", e.target.value)} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field id="billing-issuer-footer" label={t.issuerFooter}>
              <textarea id="billing-issuer-footer" className="min-h-16 w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm" maxLength={1000} value={f.issuer.footer} onChange={(e) => issuer("footer", e.target.value)} />
            </Field>
          </div>
        </CardContent>
      </Card>
      {save.error && <AdminError error={save.error} />}
      {save.isSuccess && (
        <p className="text-sm text-success" role="status">
          {t.saved}
        </p>
      )}
      <Button type="submit" disabled={save.isPending}>
        {save.isPending && <Spinner />} {t.save}
      </Button>
    </form>
  );
}

/** Admin → Instellingen → Facturatie. */
export function BillingSettingsAdmin() {
  const q = trpc.admin.billing.get.useQuery();
  if (q.error) return <QueryError error={q.error} />;
  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  return <Form initial={q.data} />;
}
