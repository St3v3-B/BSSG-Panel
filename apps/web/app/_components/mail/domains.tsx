"use client";
import { ArrowLeft, ArrowRight, AtSign, Check, Globe, Inbox, Plus, Search, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { MailDomain, MailDomainDetail } from "@panel/api";
import { MailAddress, MailDomainName, MailLocalPart } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatMb } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";
import { DnsRecords, DnsStatusBadge } from "./dns-records";
import { PasswordField } from "./forms";
import { QuotaBar, RelativeTime, Switch } from "./primitives";

function DomainCard({ d }: { d: MailDomain }) {
  const t = useT().mail;
  const pct = d.maxQuotaMb > 0 ? (d.quotaAllocatedMb / d.maxQuotaMb) * 100 : null;
  const initial = d.domain[0]?.toUpperCase() ?? "?";
  return (
    <Link
      href={`/admin/mail/domains/${d.id}`}
      className="group block rounded-2xl outline-none transition-transform hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-ring/50"
      data-testid="mail-domain-card"
    >
      <Card className={cn("relative h-full overflow-hidden p-4 transition-colors group-hover:border-primary/30 sm:p-5", !d.active && "opacity-75")}>
        <span aria-hidden className="pointer-events-none absolute -right-10 -top-10 size-28 rounded-full bg-primary/12 blur-2xl" />
        <div className="relative flex items-start gap-3">
          <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl text-lg font-bold text-white shadow-md", d.active ? "brand-gradient shadow-primary/25" : "bg-muted-foreground/50")}>{initial}</span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-base font-semibold tracking-tight">{d.domain}</h3>
              <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden />
            </div>
            <p className="truncate text-sm text-muted-foreground">{d.description || " "}</p>
          </div>
        </div>
        <div className="relative mt-3 flex flex-wrap gap-1.5">
          <DnsStatusBadge status={d.dnsStatus} />
          {!d.active && <Badge variant="secondary">{t.domains.inactive}</Badge>}
        </div>
        <div className="relative mt-4 grid grid-cols-2 gap-3 text-sm">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-muted-foreground" aria-hidden />
            <span className="tabular-nums">{t.domains.mailboxCount(d.mailboxCount, d.maxMailboxes)}</span>
          </div>
          <div className="flex items-center gap-2">
            <AtSign className="size-4 text-muted-foreground" aria-hidden />
            <span className="tabular-nums">{t.domains.aliasCount(d.aliasCount)}</span>
          </div>
        </div>
        <div className="relative mt-3 space-y-1.5">
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-muted-foreground">{t.domains.quota}</span>
            <span className="tabular-nums">{d.maxQuotaMb > 0 ? t.domains.quotaOf(formatMb(d.quotaAllocatedMb), formatMb(d.maxQuotaMb)) : `${formatMb(d.quotaAllocatedMb)} · ${t.unlimited.toLowerCase()}`}</span>
          </div>
          {pct != null && <QuotaBar pct={pct} label={t.domains.quota} />}
        </div>
        {d.dnsCheckedAt && (
          <p className="relative mt-3 text-xs text-muted-foreground">
            {t.domains.dnsChecked}{" "}
            <RelativeTime date={d.dnsCheckedAt} />
          </p>
        )}
      </Card>
    </Link>
  );
}

export function MailDomainList() {
  const t = useT().mail.domains;
  const q = trpc.mail.domains.list.useQuery();
  const [search, setSearch] = useState("");
  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((d) => !s || d.domain.includes(s) || (d.description ?? "").toLowerCase().includes(s));
  }, [q.data, search]);
  if (q.error) return <QueryError error={q.error} />;
  if (!q.data)
    return (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-busy>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-56 rounded-2xl" />
        ))}
      </div>
    );
  if (q.data.length === 0)
    return (
      <Card data-testid="mail-domains-empty">
        <EmptyState
          icon={Globe}
          title={t.emptyTitle}
          action={
            <Button asChild>
              <Link href="/admin/mail/domains/new">
                <Plus /> {t.add}
              </Link>
            </Button>
          }
        >
          {t.emptyText}
        </EmptyState>
      </Card>
    );
  return (
    <div className="space-y-4" data-testid="mail-domains">
      {q.data.length > 3 && (
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t.search} aria-label={t.search} className="pl-9" />
        </div>
      )}
      {list.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t.noResults}</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((d) => (
            <DomainCard key={d.id} d={d} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- wizard ----------

type Step = 0 | 1 | 2;

function Stepper({ step }: { step: Step }) {
  const t = useT().mail.wizard;
  const steps = [t.steps.domain, t.steps.limits, t.steps.dns];
  return (
    <ol className="flex items-center gap-2 sm:gap-3" aria-label={t.stepsLabel} data-testid="wizard-steps">
      {steps.map((label, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li key={label} className={cn("flex items-center gap-2 sm:gap-3", i < steps.length - 1 && "flex-1")} aria-current={current ? "step" : undefined}>
            <span
              className={cn(
                "grid size-8 shrink-0 place-items-center rounded-full border-2 text-sm font-semibold tabular-nums transition-all duration-300",
                done ? "border-success bg-success text-white" : current ? "border-primary bg-primary/12 text-primary shadow-[0_0_0_4px] shadow-primary/15" : "border-border text-muted-foreground",
              )}
            >
              {done ? <Check className="size-4 animate-[pop_0.4s_ease-out]" aria-hidden /> : i + 1}
            </span>
            <span className={cn("whitespace-nowrap text-sm font-medium", current ? "text-foreground" : "text-muted-foreground", !current && "max-sm:sr-only")}>{label}</span>
            {i < steps.length - 1 && (
              <span aria-hidden className="h-0.5 min-w-4 flex-1 overflow-hidden rounded-full bg-border">
                <span className={cn("block h-full bg-success transition-[width] duration-500", done ? "w-full" : "w-0")} />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

const domainOk = (v: string) => MailDomainName.safeParse(v).success;

export function DomainWizard() {
  const t = useT().mail;
  const w = t.wizard;
  const router = useRouter();
  const utils = trpc.useUtils();
  const [step, setStep] = useState<Step>(0);
  const [domain, setDomain] = useState("");
  const [touched, setTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [maxMailboxes, setMaxMailboxes] = useState("0");
  const [maxQuotaGb, setMaxQuotaGb] = useState("0");
  const [withMailbox, setWithMailbox] = useState(true);
  const [localPart, setLocalPart] = useState("info");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [quotaMb, setQuotaMb] = useState("1024");
  const [postmasterTo, setPostmasterTo] = useState("");
  const [created, setCreated] = useState<MailDomainDetail | null>(null);
  const create = trpc.mail.domains.create.useMutation({
    onSuccess: (d) => {
      setCreated(d);
      setStep(2);
      void utils.mail.domains.list.invalidate();
      void utils.mail.status.invalidate();
    },
  });
  const dom = domain.trim().toLowerCase();
  const domValid = domainOk(dom);
  const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);
  const lpValid = MailLocalPart.safeParse(localPart).success;
  const pmValid = MailAddress.safeParse(postmasterTo).success;
  const limitsValid = Number.isFinite(int(maxMailboxes)) && Number.isFinite(int(maxQuotaGb)) && (withMailbox ? lpValid && password.length >= 12 && int(quotaMb) >= 1 : pmValid);

  const submit = () =>
    create.mutate({
      domain: dom,
      description: description.trim() || null,
      maxMailboxes: int(maxMailboxes),
      maxQuotaMb: int(maxQuotaGb) * 1024,
      firstMailbox: withMailbox ? { localPart: localPart.trim().toLowerCase(), name: name.trim(), password, quotaMb: int(quotaMb) } : null,
      postmasterTo: withMailbox ? null : postmasterTo.trim().toLowerCase(),
    });

  return (
    <div className="mx-auto max-w-3xl space-y-5" data-testid="domain-wizard">
      <Card className="p-4 sm:p-5">
        <Stepper step={step} />
      </Card>

      {step === 0 && (
        <Card className="animate-rise p-5 sm:p-6">
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              setTouched(true);
              if (domValid) setStep(1);
            }}
            noValidate
          >
            <div className="space-y-1.5">
              <Label htmlFor="wiz-domain">{w.domain}</Label>
              <div className="relative">
                <Globe className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input
                  id="wiz-domain"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  onBlur={() => setTouched(true)}
                  placeholder={w.domainPlaceholder}
                  autoFocus
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                  className="h-12 pl-9 font-mono text-base md:h-11"
                  aria-invalid={(touched && !domValid && !!dom) || undefined}
                  aria-describedby="wiz-domain-hint"
                />
              </div>
              <p id="wiz-domain-hint" className={cn("text-xs", touched && dom && !domValid ? "text-destructive" : "text-muted-foreground")}>
                {touched && dom && !domValid ? w.domainInvalid : w.domainHint}
              </p>
            </div>
            <div className={cn("rounded-xl border border-dashed border-border bg-muted/30 px-4 py-3 transition-opacity", domValid ? "opacity-100" : "opacity-50")}>
              <div className="text-xs text-muted-foreground">{w.preview}</div>
              <div className="mt-1 flex flex-wrap gap-2 font-mono text-sm">
                {["info", "postmaster", "abuse"].map((lp) => (
                  <span key={lp} className="rounded-md bg-card px-2 py-0.5 shadow-xs">
                    {lp}@<span className="text-primary">{domValid ? dom : w.domainPlaceholder}</span>
                  </span>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wiz-desc">{w.descriptionLabel}</Label>
              <Input id="wiz-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={w.descriptionPlaceholder} maxLength={200} />
            </div>
            <div className="flex justify-end">
              <Button type="submit" disabled={!dom} data-testid="wizard-next">
                {t.next} <ArrowRight />
              </Button>
            </div>
          </form>
        </Card>
      )}

      {step === 1 && (
        <Card className="animate-rise p-5 sm:p-6">
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              if (limitsValid && !create.isPending) submit();
            }}
            noValidate
          >
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Globe className="size-4" aria-hidden /> <span className="font-mono text-foreground">{dom}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <div className="space-y-1.5">
                <Label htmlFor="wiz-max-mb">{w.maxMailboxes}</Label>
                <Input id="wiz-max-mb" inputMode="numeric" value={maxMailboxes} onChange={(e) => setMaxMailboxes(e.target.value)} aria-invalid={!Number.isFinite(int(maxMailboxes)) || undefined} />
                <p className="text-xs text-muted-foreground">{w.zeroUnlimited}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-max-q">{w.maxQuota}</Label>
                <Input id="wiz-max-q" inputMode="numeric" value={maxQuotaGb} onChange={(e) => setMaxQuotaGb(e.target.value)} aria-invalid={!Number.isFinite(int(maxQuotaGb)) || undefined} />
                <p className="text-xs text-muted-foreground">{w.zeroUnlimited}</p>
              </div>
            </div>
            <div className="rounded-xl border border-border bg-muted/20">
              <label className="flex cursor-pointer items-center gap-3 p-4">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
                  <Inbox className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{w.firstMailbox}</span>
                  <span className="block text-xs text-muted-foreground">{w.firstMailboxHint}</span>
                </span>
                <Switch checked={withMailbox} onCheckedChange={setWithMailbox} label={w.firstMailbox} data-testid="wizard-first-mailbox" />
              </label>
              {withMailbox ? (
                <div className="space-y-4 border-t border-border p-4">
                  <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
                    <div className="space-y-1.5">
                      <Label htmlFor="wiz-lp">{t.mailboxes.localPart}</Label>
                      <div className="flex min-w-0 items-center rounded-lg border border-input bg-background/40 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
                        <input id="wiz-lp" value={localPart} onChange={(e) => setLocalPart(e.target.value)} autoCapitalize="none" spellCheck={false} className="h-11 min-w-0 flex-1 bg-transparent px-3 font-mono text-sm outline-none md:h-9" aria-invalid={(!lpValid && !!localPart) || undefined} />
                        <span className="truncate pr-3 font-mono text-sm text-muted-foreground">@{dom}</span>
                      </div>
                      {!lpValid && localPart && <p className="text-xs text-destructive">{t.mailboxes.localPartInvalid}</p>}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="wiz-name">{t.mailboxes.displayName}</Label>
                      <Input id="wiz-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
                    </div>
                  </div>
                  <PasswordField id="wiz-pw" value={password} onChange={setPassword} />
                  <div className="max-w-48 space-y-1.5">
                    <Label htmlFor="wiz-quota">{t.mailboxes.quotaMb}</Label>
                    <Input id="wiz-quota" inputMode="numeric" value={quotaMb} onChange={(e) => setQuotaMb(e.target.value)} />
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5 border-t border-border p-4">
                  <Label htmlFor="wiz-pm">{w.postmasterTo}</Label>
                  <Input id="wiz-pm" type="email" value={postmasterTo} onChange={(e) => setPostmasterTo(e.target.value)} placeholder={t.aliases.targetPlaceholder} autoCapitalize="none" spellCheck={false} className="font-mono" />
                  <p className="text-xs text-muted-foreground">{w.postmasterHint}</p>
                </div>
              )}
            </div>
            {create.error && (
              <Alert variant="destructive">
                <AlertDescription className="mt-0">{errorText(create.error)}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              <Button variant="ghost" onClick={() => setStep(0)}>
                <ArrowLeft /> {t.back}
              </Button>
              <Button type="submit" disabled={!limitsValid || create.isPending} data-testid="wizard-create">
                {create.isPending ? <Spinner /> : <Check />} {w.create}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {step === 2 && created && (
        <div className="animate-rise space-y-4">
          <Card className="relative overflow-hidden p-5 sm:p-6" data-testid="wizard-created">
            <span aria-hidden className="pointer-events-none absolute -right-12 -top-16 size-56 rounded-full bg-success/15 blur-3xl" />
            <div className="relative flex items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-success/15 text-success">
                <Check className="size-6 animate-[pop_0.5s_ease-out]" aria-hidden />
              </span>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold break-all">{w.createdTitle(created.domain)}</h2>
                <p className="text-sm text-muted-foreground">{w.createdText}</p>
              </div>
            </div>
          </Card>
          <DnsRecords domainId={created.id} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={() => router.push("/admin/mail/domains")}>
              {w.later}
            </Button>
            <Button onClick={() => router.push(`/admin/mail/domains/${created.id}`)} data-testid="wizard-done">
              {w.done} <ArrowRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
