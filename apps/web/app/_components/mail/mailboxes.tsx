"use client";
import { CheckCircle2, KeyRound, MoreHorizontal, Pencil, Plus, Search, Trash2, Users } from "lucide-react";
import { useMemo, useState } from "react";
import type { MailDomainDetail, MailMailbox } from "@panel/api";
import { MailLocalPart } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/app/_components/ui/dropdown-menu";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { errorText } from "@/app/_lib/errors";
import { formatBytes, formatMb } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";
import { FormDialog, PasswordField, TypeToConfirmDialog } from "./forms";
import { CopyPill, QuotaBar, RelativeTime, Switch } from "./primitives";

const MB = 1024 * 1024;
/** Kolommen van de mailboxlijst vanaf md (adres, opslag, laatste login, actief, menu). */
const ROW_COLS = "md:grid-cols-[minmax(0,1.5fr)_minmax(10rem,1fr)_10rem_3rem_2.5rem] md:gap-x-5";

function Avatar({ text, muted }: { text: string; muted?: boolean }) {
  // Kleur uit het adres (stabiel), in de familie van de accentkleur.
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) % 360;
  return (
    <span aria-hidden className={cn("grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold uppercase text-white", muted && "grayscale opacity-60")} style={{ background: `linear-gradient(135deg, oklch(0.62 0.16 ${h}), oklch(0.55 0.18 ${(h + 40) % 360}))` }}>
      {text[0]}
    </span>
  );
}

function MailboxRow({ m, onEdit, onReset, onDelete }: { m: MailMailbox; onEdit: () => void; onReset: () => void; onDelete: () => void }) {
  const t = useT().mail.mailboxes;
  const utils = trpc.useUtils();
  const update = trpc.mail.mailboxes.update.useMutation({
    onMutate: async ({ active }) => {
      utils.mail.mailboxes.list.setData({ domainId: m.domainId }, (old) => old?.map((x) => (x.id === m.id ? { ...x, active: active ?? x.active } : x)));
    },
    onSettled: () => void utils.mail.mailboxes.list.invalidate({ domainId: m.domainId }),
  });
  const limit = m.quotaMb * MB;
  const pct = m.usedBytes == null ? null : (m.usedBytes / limit) * 100;
  const login = m.lastLogin ? <RelativeTime date={m.lastLogin} /> : <span className="text-muted-foreground">{t.neverLoggedIn}</span>;
  return (
    <li className={cn("grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-2.5 px-4 py-3 transition-colors hover:bg-muted/30", ROW_COLS, !m.active && "text-muted-foreground")} data-testid="mailbox-row">
      <div className="flex min-w-0 items-center gap-3">
        <Avatar text={m.localPart} muted={!m.active} />
        <div className="min-w-0">
          <div className={cn("truncate font-medium", m.active && "text-foreground")}>{m.address}</div>
          {m.name && <div className="truncate text-xs text-muted-foreground">{m.name}</div>}
        </div>
      </div>
      <div className="col-span-3 space-y-1.5 max-md:order-last md:col-span-1">
        <div className="flex justify-between gap-2 text-xs tabular-nums">
          <span>{m.usedBytes == null ? t.usedUnknown(formatMb(m.quotaMb)) : t.used(formatBytes(m.usedBytes), formatMb(m.quotaMb))}</span>
          {pct != null && <span className={cn("font-medium", pct >= 90 ? "text-destructive" : pct >= 75 ? "text-warning" : "text-muted-foreground")}>{Math.round(pct)}%</span>}
        </div>
        <QuotaBar pct={pct} label={`${t.quota} ${m.address}`} />
        <div className="text-xs text-muted-foreground md:hidden">
          {t.lastLogin}: {login}
        </div>
      </div>
      <div className="whitespace-nowrap text-sm max-md:hidden">{login}</div>
      <Switch checked={m.active} onCheckedChange={(v) => update.mutate({ id: m.id, active: v })} label={t.activeLabel(m.address)} disabled={update.isPending} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t.menu(m.address)} data-testid="mailbox-menu">
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onEdit}>
            <Pencil /> {t.edit}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onReset}>
            <KeyRound /> {t.resetPassword}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onDelete} className="text-destructive [&_svg]:text-destructive" data-testid="mailbox-delete">
            <Trash2 /> {t.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  );
}

function CreateMailboxDialog({ domain, open, onOpenChange }: { domain: MailDomainDetail; open: boolean; onOpenChange: (o: boolean) => void }) {
  const all = useT();
  const t = all.mail.mailboxes;
  const utils = trpc.useUtils();
  const [lp, setLp] = useState("");
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [quota, setQuota] = useState("1024");
  const [done, setDone] = useState<{ address: string; password: string } | null>(null);
  const create = trpc.mail.mailboxes.create.useMutation({
    onSuccess: (m) => {
      setDone({ address: m.address, password: pw });
      void utils.mail.mailboxes.list.invalidate({ domainId: domain.id });
      void utils.mail.domains.get.invalidate({ id: domain.id });
      void utils.mail.domains.list.invalidate();
    },
  });
  const reset = () => {
    setLp("");
    setName("");
    setPw("");
    setQuota("1024");
    setDone(null);
    create.reset();
  };
  const lpValid = MailLocalPart.safeParse(lp).success;
  const q = /^\d+$/.test(quota) ? Number(quota) : NaN;
  const left = domain.maxQuotaMb > 0 ? domain.maxQuotaMb - domain.quotaAllocatedMb : null;
  const valid = lpValid && pw.length >= 12 && q >= 1;
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title={done ? t.created(done.address) : t.createTitle}
      description={done ? undefined : t.createText(domain.domain)}
      submitLabel={done ? all.common.close : t.createGo}
      pending={create.isPending}
      error={create.error}
      disabled={!done && !valid}
      onSubmit={() => (done ? (reset(), onOpenChange(false)) : create.mutate({ domainId: domain.id, localPart: lp.trim().toLowerCase(), name: name.trim(), password: pw, quotaMb: q, active: true }))}
      testId="mailbox-create"
    >
      {done ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 className="size-5 animate-[pop_0.4s_ease-out]" />
            <span className="text-sm font-medium">{t.created(done.address)}</span>
          </div>
          <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3">
            {[
              [t.address, done.address],
              [t.password, done.password],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-xs text-muted-foreground">{k}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-sm">{v}</code>
                <CopyPill value={v!} label={`${all.mail.copy} ${k}`} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="mb-lp">{t.localPart}</Label>
            <div className="flex min-w-0 items-center rounded-lg border border-input bg-background/40 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
              <input
                id="mb-lp"
                value={lp}
                onChange={(e) => setLp(e.target.value)}
                autoFocus
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                className="h-11 min-w-0 flex-1 bg-transparent px-3 font-mono text-sm outline-none md:h-9"
                aria-invalid={(!!lp && !lpValid) || undefined}
              />
              <span className="max-w-[55%] truncate pr-3 font-mono text-sm text-muted-foreground">@{domain.domain}</span>
            </div>
            {lp && !lpValid && <p className="text-xs text-destructive">{t.localPartInvalid}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mb-name">{t.displayName}</Label>
            <Input id="mb-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </div>
          <PasswordField id="mb-pw" value={pw} onChange={setPw} />
          <div className="space-y-1.5">
            <Label htmlFor="mb-quota">{t.quotaMb}</Label>
            <Input id="mb-quota" inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} className="max-w-40" />
            {left != null && <p className={cn("text-xs", Number.isFinite(q) && q > left ? "text-destructive" : "text-muted-foreground")}>{t.quotaHint(formatMb(Math.max(0, left)))}</p>}
          </div>
        </>
      )}
    </FormDialog>
  );
}

function EditMailboxDialog({ m, onClose }: { m: MailMailbox; onClose: () => void }) {
  const t = useT().mail.mailboxes;
  const utils = trpc.useUtils();
  const [name, setName] = useState(m.name);
  const [quota, setQuota] = useState(String(m.quotaMb));
  const q = /^\d+$/.test(quota) ? Number(quota) : NaN;
  const update = trpc.mail.mailboxes.update.useMutation({
    onSuccess: () => {
      void utils.mail.mailboxes.list.invalidate({ domainId: m.domainId });
      void utils.mail.domains.get.invalidate({ id: m.domainId });
      onClose();
    },
  });
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={t.editTitle(m.address)} submitLabel={t.saveGo} pending={update.isPending} error={update.error} disabled={!(q >= 1)} onSubmit={() => update.mutate({ id: m.id, name: name.trim(), quotaMb: q })}>
      <div className="space-y-1.5">
        <Label htmlFor="mbe-name">{t.displayName}</Label>
        <Input id="mbe-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="mbe-quota">{t.quotaMb}</Label>
        <Input id="mbe-quota" inputMode="numeric" value={quota} onChange={(e) => setQuota(e.target.value)} className="max-w-40" />
      </div>
    </FormDialog>
  );
}

function ResetPasswordDialog({ m, onClose }: { m: MailMailbox; onClose: () => void }) {
  const all = useT();
  const t = all.mail.mailboxes;
  const [pw, setPw] = useState("");
  const set = trpc.mail.mailboxes.setPassword.useMutation();
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={t.resetTitle(m.address)}
      description={t.resetText}
      submitLabel={set.isSuccess ? all.common.close : t.resetGo}
      pending={set.isPending}
      error={set.error}
      disabled={!set.isSuccess && pw.length < 12}
      onSubmit={() => (set.isSuccess ? onClose() : set.mutate({ id: m.id, password: pw }))}
      testId="mailbox-reset"
    >
      <PasswordField id="mbr-pw" value={pw} onChange={(v) => (set.reset(), setPw(v))} autoFocus />
      {set.isSuccess && (
        <p className="flex items-center gap-1.5 text-sm text-success" role="status">
          <CheckCircle2 className="size-4" /> {t.resetDone}
        </p>
      )}
    </FormDialog>
  );
}

export function MailboxesPanel({ domain }: { domain: MailDomainDetail }) {
  const t = useT().mail.mailboxes;
  const utils = trpc.useUtils();
  const q = trpc.mail.mailboxes.list.useQuery({ domainId: domain.id });
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<MailMailbox | null>(null);
  const [resetting, setResetting] = useState<MailMailbox | null>(null);
  const [deleting, setDeleting] = useState<MailMailbox | null>(null);
  const del = trpc.mail.mailboxes.delete.useMutation({
    onSuccess: () => {
      setDeleting(null);
      void utils.mail.mailboxes.list.invalidate({ domainId: domain.id });
      void utils.mail.domains.get.invalidate({ id: domain.id });
      void utils.mail.domains.list.invalidate();
    },
  });
  const list = useMemo(() => {
    const s = search.trim().toLowerCase();
    return (q.data ?? []).filter((m) => !s || m.address.includes(s) || m.name.toLowerCase().includes(s));
  }, [q.data, search]);
  const atLimit = domain.maxMailboxes > 0 && (q.data?.length ?? domain.mailboxCount) >= domain.maxMailboxes;

  if (q.error) return <QueryError error={q.error} />;
  const addButton = (
    <Button onClick={() => setCreating(true)} disabled={atLimit} data-testid="mailbox-add">
      <Plus /> {t.add}
    </Button>
  );
  return (
    <div className="space-y-4">
      {q.data && q.data.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t.search} aria-label={t.search} className="pl-9" data-testid="mailbox-search" />
          </div>
          <div className="sm:ml-auto">{addButton}</div>
        </div>
      )}
      {atLimit && (
        <Alert variant="info">
          <AlertDescription className="mt-0">{t.limitReached(domain.maxMailboxes)}</AlertDescription>
        </Alert>
      )}
      {!q.data ? (
        <Card className="space-y-3 p-4" aria-busy>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-full" />
              <Skeleton className="h-4 w-48" />
              <Skeleton className="ml-auto h-2 w-40" />
            </div>
          ))}
        </Card>
      ) : q.data.length === 0 ? (
        <Card>
          <EmptyState icon={Users} title={t.emptyTitle} action={addButton}>
            {t.emptyText}
          </EmptyState>
        </Card>
      ) : list.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t.noResults}</p>
      ) : (
        <Card className="overflow-hidden">
          <div aria-hidden className={cn("grid border-b border-border bg-muted/30 px-4 py-2.5 text-xs font-medium text-muted-foreground max-md:hidden", ROW_COLS)}>
            <span>{t.address}</span>
            <span>{t.quota}</span>
            <span>{t.lastLogin}</span>
            <span>{t.active}</span>
            <span />
          </div>
          <ul className="divide-y divide-border" data-testid="mailbox-table" aria-label={t.address}>
            {list.map((m) => (
              <MailboxRow key={m.id} m={m} onEdit={() => setEditing(m)} onReset={() => setResetting(m)} onDelete={() => (del.reset(), setDeleting(m))} />
            ))}
          </ul>
        </Card>
      )}
      <CreateMailboxDialog domain={domain} open={creating} onOpenChange={setCreating} />
      {editing && <EditMailboxDialog m={editing} onClose={() => setEditing(null)} />}
      {resetting && <ResetPasswordDialog m={resetting} onClose={() => setResetting(null)} />}
      <TypeToConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={deleting ? t.deleteTitle(deleting.address) : ""}
        description={t.deleteText}
        confirmText={deleting?.address ?? ""}
        actionLabel={t.deleteGo}
        pending={del.isPending}
        error={del.error}
        onConfirm={() => deleting && del.mutate({ id: deleting.id })}
      />
      {/* fout van een snelle actie (bv. actief-schakelaar) */}
      {del.error && !deleting && <p className="text-sm text-destructive">{errorText(del.error)}</p>}
    </div>
  );
}
