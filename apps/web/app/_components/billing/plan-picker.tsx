"use client";
import type { Plan } from "@panel/api";
import { Cpu, Database, HardDrive, MemoryStick, Package, Plug, Save } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { formatMoney, mb, PriceText } from "@/app/_components/billing/common";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatCpuLimit } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

/** Absolute URL's (betaalpagina van de provider) verlaten het panel; relatieve gaan via de router. */
export function go(router: { push: (u: string) => void }, url: string) {
  if (/^https?:\/\//.test(url)) window.location.assign(url);
  else router.push(url);
}

function PlanCard({ plan, onChoose, disabled }: { plan: Plan; onChoose: () => void; disabled: boolean }) {
  const t = useT().billing.plans;
  const feat = [
    { icon: MemoryStick, text: `${t.ram}: ${mb(plan.ramMb)}` },
    { icon: Cpu, text: `${t.cpu}: ${formatCpuLimit(plan.cpuPct)}` },
    { icon: HardDrive, text: `${t.disk}: ${mb(plan.diskMb)}` },
    ...(plan.type === "game" ? [{ icon: Plug, text: t.ports(plan.allocations) }] : []),
    { icon: Database, text: t.databases(plan.maxDatabases) },
    { icon: Save, text: t.backups(plan.maxBackups) },
  ];
  return (
    <Card className="flex flex-col" data-testid="plan-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-lg">{plan.name}</CardTitle>
          <Badge variant="secondary">{plan.type === "game" ? t.game : t.web}</Badge>
        </div>
        <div className="text-2xl font-bold tracking-tight" data-testid="plan-price">
          <PriceText cents={plan.priceCents} currency={plan.currency} />
        </div>
        {plan.description && <CardDescription className="whitespace-pre-line">{plan.description}</CardDescription>}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <ul className="space-y-1.5 text-sm">
          {feat.map((f) => (
            <li key={f.text} className="flex items-center gap-2">
              <f.icon className="size-4 text-muted-foreground" aria-hidden /> {f.text}
            </li>
          ))}
        </ul>
        <Button className="mt-auto" onClick={onChoose} disabled={disabled}>
          {t.choose}
        </Button>
      </CardContent>
    </Card>
  );
}

/** Pagina Pakketten: kiezen, naam + template, en dan gratis aanmaken of door naar de betaalpagina. */
export function PlanPicker() {
  const t = useT().billing;
  const router = useRouter();
  const utils = trpc.useUtils();
  const status = trpc.billing.status.useQuery();
  const plans = trpc.billing.plans.useQuery();
  const [chosen, setChosen] = useState<Plan | null>(null);
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState<number | null>(null);
  const subscribe = trpc.billing.subscribe.useMutation({
    onSuccess: async (r) => {
      await Promise.all([utils.servers.list.invalidate(), utils.billing.invalidate()]);
      go(router, r.checkoutUrl ?? `/servers/${r.serverUuid}`);
    },
  });

  if (status.error) return <QueryError error={status.error} />;
  if (plans.error) return <QueryError error={plans.error} />;
  if (!status.data || !plans.data) return <Skeleton className="h-64 rounded-xl" />;
  if (!status.data.plansEnabled) return <EmptyState icon={Package} title={t.plans.disabled} />;
  if (plans.data.length === 0) return <EmptyState icon={Package} title={t.plans.empty} />;

  if (chosen) {
    const tpl = templateId ?? chosen.templates[0]?.id ?? null;
    const paid = status.data.billingEnabled && chosen.priceCents > 0;
    const valid = !!name.trim() && tpl !== null;
    return (
      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle className="text-base">{t.plans.chosen(chosen.name)}</CardTitle>
          <CardDescription>{paid ? formatMoney(chosen.priceCents, chosen.currency) + " · " + t.plans.paidHint : t.free}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) subscribe.mutate({ planId: chosen.id, name: name.trim(), templateId: tpl!, variables: {} });
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="plan-name">{t.plans.name}</Label>
              <Input id="plan-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="plan-template">{t.plans.template}</Label>
              <Select id="plan-template" value={tpl ?? ""} onChange={(e) => setTemplateId(Number(e.target.value))}>
                {chosen.templates.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            </div>
            {subscribe.error && (
              <p className="text-sm text-destructive" role="alert">
                {errorText(subscribe.error)}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={!valid || subscribe.isPending}>
                {subscribe.isPending && <Spinner />} {paid ? t.plans.submitPaid : t.plans.submitFree}
              </Button>
              <Button type="button" variant="ghost" onClick={() => (setChosen(null), subscribe.reset())}>
                {t.plans.back}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {!status.data.canSubscribe && (
        <Alert variant="info">
          <AlertDescription>{t.plans.selfServiceOff}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" data-testid="plan-list">
        {plans.data.map((p) => (
          <PlanCard key={p.id} plan={p} disabled={!status.data!.canSubscribe} onChoose={() => (setChosen(p), setTemplateId(null))} />
        ))}
      </div>
    </div>
  );
}
