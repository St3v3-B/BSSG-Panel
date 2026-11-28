"use client";
import { ArrowLeft, AtSign, CheckCircle2, Fingerprint, Globe, KeyRound, RotateCw, SlidersHorizontal, Trash2, Users } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { MailDomainDetail } from "@panel/api";
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
import { useDocumentTitle } from "@/app/_hooks/use-document-title";
import { errorText } from "@/app/_lib/errors";
import { formatDate, formatMb } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";
import { AliasesPanel } from "./aliases";
import { DnsRecords, DnsStatusBadge } from "./dns-records";
import { ConfirmDialog, FormDialog, TypeToConfirmDialog } from "./forms";
import { MailboxesPanel } from "./mailboxes";
import { CopyPill, CopyValue, QuotaBar, RelativeTime, Switch, TabPanel, Tabs } from "./primitives";

type TabKey = "mailboxes" | "aliases" | "dns" | "dkim";
const TAB_KEYS: TabKey[] = ["mailboxes", "aliases", "dns", "dkim"];

function DkimPanel({ domain, onShowDns }: { domain: MailDomainDetail; onShowDns: () => void }) {
  const tm = useT().mail;
  const t = tm.dkim;
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState(false);
  const [selector, setSelector] = useState("");
  const rotate = trpc.mail.domains.rotateDkim.useMutation({
    onSuccess: (r) => {
      setConfirm(false);
      setSelector("");
      utils.mail.domains.dnsRecords.setData({ id: domain.id }, r);
      void utils.mail.domains.get.invalidate({ id: domain.id });
      void utils.mail.domains.list.invalidate();
    },
  });
  const k = domain.dkim;
  const selValid = !selector || /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(selector);
  if (!k)
    return (
      <Card>
        <EmptyState icon={KeyRound} title={t.noKey} />
      </Card>
    );
  const recordName = `${k.selector}._domainkey.${domain.domain}`;
  const recordValue = `v=DKIM1; k=rsa; p=${k.publicKey}`;
  return (
    <div className="space-y-4" data-testid="dkim-panel">
      {rotate.isSuccess && (
        <Alert variant="info" role="status">
          <CheckCircle2 />
          <div className="flex-1">
            <AlertDescription className="mt-0">{t.rotatedDone}</AlertDescription>
          </div>
          <Button size="sm" variant="outline" onClick={onShowDns}>
            {tm.dns.title}
          </Button>
        </Alert>
      )}
      <Card className="relative overflow-hidden">
        <span aria-hidden className="pointer-events-none absolute -right-12 -top-16 size-52 rounded-full bg-primary/12 blur-3xl" />
        <div className="relative flex flex-col gap-4 border-b border-border p-5 sm:flex-row sm:items-start">
          <span className="grid size-12 shrink-0 place-items-center rounded-2xl brand-gradient text-white shadow-lg shadow-primary/25">
            <Fingerprint className="size-6" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">{t.title}</h3>
            <p className="text-sm text-muted-foreground">{t.description}</p>
          </div>
          <Button variant="outline" onClick={() => (rotate.reset(), setConfirm(true))} data-testid="dkim-rotate">
            <RotateCw /> {t.rotate}
          </Button>
        </div>
        <dl className="relative grid gap-4 p-5 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted-foreground">{t.selector}</dt>
            <dd className="mt-1 flex items-center gap-2">
              <code className="rounded-md bg-muted px-2 py-0.5 font-mono text-sm font-semibold" data-testid="dkim-selector">
                {k.selector}
              </code>
              <CopyPill value={k.selector} label={`${t.selector} ${k.selector}`} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.created}</dt>
            <dd className="mt-1 text-sm">
              {formatDate(k.createdAt)}
              <span className="block text-xs text-muted-foreground">{t.keyInfo}</span>
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">{t.rotated}</dt>
            <dd className="mt-1 text-sm">{k.rotatedAt ? <RelativeTime date={k.rotatedAt} /> : <span className="text-muted-foreground">{t.neverRotated}</span>}</dd>
          </div>
        </dl>
        <div className="relative space-y-4 border-t border-border p-5">
          <div className="space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t.record}</div>
            <div className="flex items-center gap-2">
              <span className="inline-flex h-7 items-center rounded-lg bg-info/12 px-2 font-mono text-xs font-bold text-info ring-1 ring-inset ring-info/25">TXT</span>
              <code className="min-w-0 flex-1 truncate font-mono text-sm" title={recordName}>
                {recordName}
              </code>
              <CopyPill value={recordName} label={tm.dns.copyName(recordName)} />
            </div>
            <CopyValue value={recordValue} label={tm.dns.copyValue("DKIM")} />
          </div>
          <div className="space-y-1.5">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t.publicKey}</div>
            <CopyValue value={k.publicKey} label={t.publicKey} />
          </div>
        </div>
      </Card>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        icon={<RotateCw />}
        tone="warning"
        title={t.rotateTitle}
        description={t.rotateText}
        actionLabel={t.rotateGo}
        pending={rotate.isPending}
        error={rotate.error}
        onConfirm={() => selValid && rotate.mutate({ id: domain.id, selector: selector || undefined })}
      >
        <div className="mt-4 space-y-1.5">
          <Label htmlFor="dkim-sel">{t.newSelector}</Label>
          <Input id="dkim-sel" value={selector} onChange={(e) => setSelector(e.target.value.toLowerCase())} placeholder={`dkim${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`} className="font-mono" aria-invalid={!selValid || undefined} autoCapitalize="none" spellCheck={false} />
          <p className={cn("text-xs", selValid ? "text-muted-foreground" : "text-destructive")}>{selValid ? t.newSelectorHint : t.selectorInvalid}</p>
        </div>
      </ConfirmDialog>
    </div>
  );
}

function LimitsDialog({ domain, onClose }: { domain: MailDomainDetail; onClose: () => void }) {
  const t = useT().mail;
  const utils = trpc.useUtils();
  const [desc, setDesc] = useState(domain.description ?? "");
  const [maxMb, setMaxMb] = useState(String(domain.maxMailboxes));
  const [maxGb, setMaxGb] = useState(String(Math.round(domain.maxQuotaMb / 1024)));
  const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN);
  const update = trpc.mail.domains.update.useMutation({
    onSuccess: () => {
      void utils.mail.domains.get.invalidate({ id: domain.id });
      void utils.mail.domains.list.invalidate();
      onClose();
    },
  });
  const valid = Number.isFinite(int(maxMb)) && Number.isFinite(int(maxGb));
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={t.detail.limitsTitle} submitLabel={t.detail.saveLimits} pending={update.isPending} error={update.error} disabled={!valid} onSubmit={() => update.mutate({ id: domain.id, description: desc.trim() || null, maxMailboxes: int(maxMb), maxQuotaMb: int(maxGb) * 1024 })}>
      <div className="space-y-1.5">
        <Label htmlFor="lim-desc">{t.wizard.descriptionLabel}</Label>
        <Input id="lim-desc" value={desc} onChange={(e) => setDesc(e.target.value)} maxLength={200} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
        <div className="space-y-1.5">
          <Label htmlFor="lim-mb">{t.wizard.maxMailboxes}</Label>
          <Input id="lim-mb" inputMode="numeric" value={maxMb} onChange={(e) => setMaxMb(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t.wizard.zeroUnlimited}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="lim-q">{t.wizard.maxQuota}</Label>
          <Input id="lim-q" inputMode="numeric" value={maxGb} onChange={(e) => setMaxGb(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t.wizard.zeroUnlimited}</p>
        </div>
      </div>
    </FormDialog>
  );
}

function DomainHeader({ d }: { d: MailDomainDetail }) {
  const t = useT().mail;
  const router = useRouter();
  const utils = trpc.useUtils();
  const [limits, setLimits] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const toggle = trpc.mail.domains.update.useMutation({
    onSuccess: () => {
      void utils.mail.domains.get.invalidate({ id: d.id });
      void utils.mail.domains.list.invalidate();
    },
  });
  const del = trpc.mail.domains.delete.useMutation({
    onSuccess: () => {
      void utils.mail.domains.list.invalidate();
      void utils.mail.status.invalidate();
      router.push("/admin/mail/domains");
    },
  });
  const pct = d.maxQuotaMb > 0 ? (d.quotaAllocatedMb / d.maxQuotaMb) * 100 : null;
  return (
    <Card className="relative overflow-hidden" data-testid="mail-domain-header">
      <span aria-hidden className="pointer-events-none absolute -left-16 -top-24 size-72 rounded-full bg-primary/12 blur-3xl" />
      <div className="relative flex flex-col gap-4 p-5 sm:p-6 lg:flex-row lg:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-4">
          <span className={cn("grid size-14 shrink-0 place-items-center rounded-2xl text-2xl font-bold text-white shadow-lg", d.active ? "brand-gradient shadow-primary/30" : "bg-muted-foreground/50")}>{d.domain[0]?.toUpperCase()}</span>
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-bold tracking-tight sm:text-3xl">{d.domain}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <DnsStatusBadge status={d.dnsStatus} />
              {!d.active && <Badge variant="secondary">{t.domains.inactive}</Badge>}
              {d.description && <span className="text-sm text-muted-foreground">{d.description}</span>}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="mr-2 flex items-center gap-2.5 text-sm" title={t.detail.activeHint}>
            <Switch checked={d.active} onCheckedChange={(v) => toggle.mutate({ id: d.id, active: v })} disabled={toggle.isPending} label={t.detail.active} data-testid="domain-active" />
            {t.detail.active}
          </label>
          <Button variant="outline" onClick={() => setLimits(true)}>
            <SlidersHorizontal /> {t.detail.editLimits}
          </Button>
          <Button variant="outline" className="text-destructive hover:bg-destructive/10" onClick={() => (del.reset(), setDeleting(true))} data-testid="domain-delete">
            <Trash2 /> <span className="max-sm:sr-only">{t.detail.deleteDomain}</span>
          </Button>
        </div>
      </div>
      {toggle.error && <p className="relative px-6 pb-3 text-sm text-destructive">{errorText(toggle.error)}</p>}
      <dl className="relative grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3">
        <div className="bg-card px-5 py-3.5">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Users className="size-3.5" aria-hidden /> {t.overview.mailboxes}
          </dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">
            {d.mailboxCount}
            {d.maxMailboxes > 0 && <span className="text-sm font-normal text-muted-foreground"> / {d.maxMailboxes}</span>}
          </dd>
        </div>
        <div className="bg-card px-5 py-3.5">
          <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <AtSign className="size-3.5" aria-hidden /> {t.overview.aliases}
          </dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums">{d.aliasCount}</dd>
        </div>
        <div className="col-span-2 bg-card px-5 py-3.5 sm:col-span-1">
          <dt className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{t.domains.quota}</span>
            <span className="tabular-nums text-foreground">{d.maxQuotaMb > 0 ? t.domains.quotaOf(formatMb(d.quotaAllocatedMb), formatMb(d.maxQuotaMb)) : `${formatMb(d.quotaAllocatedMb)} · ${t.unlimited.toLowerCase()}`}</span>
          </dt>
          {pct != null && (
            <dd className="mt-2.5">
              <QuotaBar pct={pct} label={t.domains.quota} />
            </dd>
          )}
        </div>
      </dl>
      {limits && <LimitsDialog domain={d} onClose={() => setLimits(false)} />}
      <TypeToConfirmDialog open={deleting} onOpenChange={setDeleting} title={t.detail.deleteTitle(d.domain)} description={t.detail.deleteText} confirmText={d.domain} actionLabel={t.detail.deleteGo} pending={del.isPending} error={del.error} onConfirm={() => del.mutate({ id: d.id })} />
    </Card>
  );
}

export function MailDomainDetailView({ id }: { id: number }) {
  const t = useT().mail;
  const q = trpc.mail.domains.get.useQuery({ id }, { retry: false });
  const [tab, setTab] = useState<TabKey>("mailboxes");
  useDocumentTitle(q.data?.domain ?? t.domains.docTitle);
  useEffect(() => {
    const h = window.location.hash.slice(1) as TabKey;
    if (TAB_KEYS.includes(h)) setTab(h);
  }, []);
  const change = (k: TabKey) => {
    setTab(k);
    window.history.replaceState(null, "", `#${k}`);
  };
  const back = (
    <Link href="/admin/mail/domains" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
      <ArrowLeft className="size-4" /> {t.detail.back}
    </Link>
  );
  if (q.error)
    return (
      <div className="space-y-4">
        {back}
        <QueryError error={q.error} />
      </div>
    );
  if (!q.data)
    return (
      <div className="space-y-4" aria-busy>
        {back}
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-11 w-full max-w-md" />
        <Skeleton className="h-72 rounded-2xl" />
      </div>
    );
  const d = q.data;
  const tabs = [
    { key: "mailboxes" as const, label: t.detail.tabs.mailboxes, icon: Users, count: d.mailboxCount },
    { key: "aliases" as const, label: t.detail.tabs.aliases, icon: AtSign, count: d.aliasCount },
    { key: "dns" as const, label: t.detail.tabs.dns, icon: Globe },
    { key: "dkim" as const, label: t.detail.tabs.dkim, icon: Fingerprint },
  ];
  return (
    <div className="space-y-5" data-testid="mail-domain-detail">
      {back}
      <DomainHeader d={d} />
      <Tabs tabs={tabs} value={tab} onChange={change} label={t.detail.tabsLabel} idBase="mail-domain" />
      <TabPanel idBase="mail-domain" k={tab}>
        <div key={tab} className="animate-fade">
          {tab === "mailboxes" && <MailboxesPanel domain={d} />}
          {tab === "aliases" && <AliasesPanel domain={d} />}
          {tab === "dns" && <DnsRecords domainId={d.id} />}
          {tab === "dkim" && <DkimPanel domain={d} onShowDns={() => change("dns")} />}
        </div>
      </TabPanel>
    </div>
  );
}
