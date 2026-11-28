"use client";
import { Asterisk, AtSign, CornerDownRight, Forward, Pencil, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { useState, type KeyboardEvent } from "react";
import type { MailAlias, MailDomainDetail } from "@panel/api";
import { MailAddress, MailLocalPart } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";
import { ConfirmDialog, FormDialog } from "./forms";
import { Switch } from "./primitives";

const SYSTEM = new Set(["postmaster", "abuse"]);
const localOf = (a: string) => a.slice(0, a.indexOf("@"));

/** Invoer voor e-mailadressen als chips (Enter, komma of spatie maakt een chip). */
export function AddressChips({ id, value, onChange, suggestions = [] }: { id: string; value: string[]; onChange: (v: string[]) => void; suggestions?: string[] }) {
  const t = useT().mail.aliases;
  const [draft, setDraft] = useState("");
  const [bad, setBad] = useState<string | null>(null);
  const commit = (raw: string) => {
    const parts = raw.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!parts.length) return true;
    const invalid = parts.find((p) => !MailAddress.safeParse(p).success);
    if (invalid) {
      setBad(invalid);
      return false;
    }
    setBad(null);
    onChange([...new Set([...value, ...parts])]);
    setDraft("");
    return true;
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === "," || (e.key === " " && draft.trim())) {
      if (draft.trim()) {
        e.preventDefault();
        commit(draft);
      }
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  const listId = `${id}-suggest`;
  return (
    <div className="space-y-1.5">
      <div className={cn("flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background/40 p-1.5 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25 md:min-h-9", bad && "border-destructive")}>
        {value.map((a) => (
          <span key={a} className="inline-flex max-w-full items-center gap-1 rounded-md bg-primary/12 py-0.5 pl-2 pr-0.5 font-mono text-xs text-primary" data-testid="target-chip">
            <span className="truncate">{a}</span>
            <button type="button" onClick={() => onChange(value.filter((x) => x !== a))} className="grid size-6 place-items-center rounded hover:bg-primary/20" aria-label={t.removeTarget(a)}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          onChange={(e) => (setDraft(e.target.value), setBad(null))}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && commit(draft)}
          placeholder={value.length ? "" : t.targetPlaceholder}
          list={suggestions.length ? listId : undefined}
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          className="h-8 min-w-40 flex-1 bg-transparent px-1.5 font-mono text-sm outline-none"
          aria-describedby={`${id}-hint`}
          aria-invalid={!!bad || undefined}
        />
        {suggestions.length > 0 && (
          <datalist id={listId}>
            {suggestions.filter((s) => !value.includes(s)).map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </div>
      <p id={`${id}-hint`} className={cn("text-xs", bad ? "text-destructive" : "text-muted-foreground")}>
        {bad ? t.targetInvalid(bad) : t.targetsHint}
      </p>
    </div>
  );
}

function AliasRow({ a, onEdit, onDelete }: { a: MailAlias; onEdit: () => void; onDelete: () => void }) {
  const t = useT().mail.aliases;
  const utils = trpc.useUtils();
  const update = trpc.mail.aliases.update.useMutation({
    onMutate: ({ active }) => utils.mail.aliases.list.setData({ domainId: a.domainId }, (old) => old?.map((x) => (x.id === a.id ? { ...x, active: active ?? x.active } : x))),
    onSettled: () => void utils.mail.aliases.list.invalidate({ domainId: a.domainId }),
  });
  const system = !a.catchAll && SYSTEM.has(localOf(a.address));
  return (
    <li
      className={cn(
        "relative flex flex-col gap-3 p-4 sm:flex-row sm:items-center",
        a.catchAll && "bg-gradient-to-r from-primary/[0.07] to-transparent",
        !a.active && "opacity-60",
      )}
      data-testid={a.catchAll ? "alias-catchall" : "alias-row"}
    >
      {a.catchAll && <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 brand-gradient" />}
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-xl", a.catchAll ? "brand-gradient text-white shadow-md shadow-primary/25" : "bg-muted text-muted-foreground")}>
          {a.catchAll ? <Asterisk className="size-4" aria-hidden /> : <AtSign className="size-4" aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-sm font-medium">{a.catchAll ? <><span className="text-primary">*</span>{a.address}</> : a.address}</span>
            {a.catchAll && (
              <Badge variant="default" title={t.catchAllHint}>
                {t.catchAll}
              </Badge>
            )}
            {system && (
              <Badge variant="secondary" title={t.systemHint}>
                <ShieldCheck /> {t.system}
              </Badge>
            )}
          </div>
          {a.catchAll && <p className="mt-0.5 text-xs text-muted-foreground">{t.catchAllHint}</p>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <CornerDownRight className="size-3.5 text-muted-foreground" aria-label={t.targets} />
            {a.goto.map((g) => (
              <span key={g} className="inline-flex max-w-full items-center rounded-md border border-border bg-card px-2 py-0.5 font-mono text-xs" data-testid="alias-target">
                <span className="truncate">{g}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 self-end sm:self-center">
        <Switch checked={a.active} onCheckedChange={(v) => update.mutate({ id: a.id, active: v })} label={t.activeLabel(a.address)} disabled={update.isPending} className="mr-2" />
        <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`${t.edit} ${a.address}`}>
          <Pencil />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onDelete} aria-label={`${t.delete} ${a.address}`} className="text-muted-foreground hover:text-destructive" data-testid="alias-delete">
          <Trash2 />
        </Button>
      </div>
    </li>
  );
}

function AliasDialog({ domain, alias, hasCatchAll, suggestions, onClose }: { domain: MailDomainDetail; alias: MailAlias | null; hasCatchAll: boolean; suggestions: string[]; onClose: () => void }) {
  const tm = useT().mail;
  const t = tm.aliases;
  const utils = trpc.useUtils();
  const [kind, setKind] = useState<"alias" | "catchall">("alias");
  const [lp, setLp] = useState("");
  const [goto, setGoto] = useState<string[]>(alias?.goto ?? []);
  const done = () => {
    void utils.mail.aliases.list.invalidate({ domainId: domain.id });
    void utils.mail.domains.list.invalidate();
    onClose();
  };
  const create = trpc.mail.aliases.create.useMutation({ onSuccess: done });
  const update = trpc.mail.aliases.update.useMutation({ onSuccess: done });
  const mut = alias ? update : create;
  const lpValid = kind === "catchall" || MailLocalPart.safeParse(lp).success;
  const valid = goto.length > 0 && (alias ? true : lpValid);
  return (
    <FormDialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={alias ? t.editTitle(alias.address) : t.createTitle}
      submitLabel={alias ? t.saveGo : t.createGo}
      pending={mut.isPending}
      error={mut.error}
      disabled={!valid}
      onSubmit={() => (alias ? update.mutate({ id: alias.id, goto }) : create.mutate({ domainId: domain.id, localPart: kind === "catchall" ? null : lp.trim().toLowerCase(), goto, active: true }))}
      testId="alias-dialog"
    >
      {!alias && (
        <div role="radiogroup" aria-label={t.createTitle} className="grid grid-cols-2 gap-2">
          {(["alias", "catchall"] as const).map((k) => {
            const disabled = k === "catchall" && hasCatchAll;
            const sel = kind === k;
            return (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={sel}
                disabled={disabled}
                onClick={() => setKind(k)}
                title={disabled ? t.catchAllExists : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-xl border p-3 text-left text-sm outline-none transition-all focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
                  sel ? "border-primary bg-primary/[0.08] shadow-[0_0_0_3px] shadow-primary/15" : "border-border hover:bg-accent",
                )}
              >
                <span className={cn("grid size-8 place-items-center rounded-lg", sel ? "brand-gradient text-white" : "bg-muted text-muted-foreground")}>{k === "alias" ? <Forward className="size-4" /> : <Asterisk className="size-4" />}</span>
                <span className="font-medium">{k === "alias" ? t.typeAlias : t.typeCatchAll}</span>
              </button>
            );
          })}
        </div>
      )}
      {!alias && kind === "catchall" && <p className="text-xs text-muted-foreground">{t.catchAllHint}</p>}
      {!alias && kind === "alias" && (
        <div className="space-y-1.5">
          <Label htmlFor="al-lp">{t.localPart}</Label>
          <div className="flex min-w-0 items-center rounded-lg border border-input bg-background/40 focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
            <input id="al-lp" value={lp} onChange={(e) => setLp(e.target.value)} autoFocus autoCapitalize="none" autoComplete="off" spellCheck={false} className="h-11 min-w-0 flex-1 bg-transparent px-3 font-mono text-sm outline-none md:h-9" aria-invalid={(!!lp && !lpValid) || undefined} />
            <span className="max-w-[55%] truncate pr-3 font-mono text-sm text-muted-foreground">@{domain.domain}</span>
          </div>
          {lp && !lpValid && <p className="text-xs text-destructive">{tm.mailboxes.localPartInvalid}</p>}
        </div>
      )}
      <div className="space-y-1.5">
        <Label htmlFor="al-goto">{t.targetsLabel}</Label>
        <AddressChips id="al-goto" value={goto} onChange={setGoto} suggestions={suggestions} />
      </div>
    </FormDialog>
  );
}

export function AliasesPanel({ domain }: { domain: MailDomainDetail }) {
  const t = useT().mail.aliases;
  const utils = trpc.useUtils();
  const q = trpc.mail.aliases.list.useQuery({ domainId: domain.id });
  const boxes = trpc.mail.mailboxes.list.useQuery({ domainId: domain.id });
  const [dialog, setDialog] = useState<{ alias: MailAlias | null } | null>(null);
  const [deleting, setDeleting] = useState<MailAlias | null>(null);
  const del = trpc.mail.aliases.delete.useMutation({
    onSuccess: () => {
      setDeleting(null);
      void utils.mail.aliases.list.invalidate({ domainId: domain.id });
      void utils.mail.domains.list.invalidate();
    },
  });
  if (q.error) return <QueryError error={q.error} />;
  const list = [...(q.data ?? [])].sort((a, b) => Number(b.catchAll) - Number(a.catchAll) || a.address.localeCompare(b.address));
  const hasCatchAll = list.some((a) => a.catchAll);
  const suggestions = (boxes.data ?? []).map((m) => m.address);
  const add = (
    <Button onClick={() => setDialog({ alias: null })} data-testid="alias-add">
      <Plus /> {t.add}
    </Button>
  );
  return (
    <div className="space-y-4">
      {list.length > 0 && <div className="flex justify-end">{add}</div>}
      {!q.data ? (
        <Card className="space-y-4 p-4" aria-busy>
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-9 rounded-xl" />
              <div className="space-y-1.5">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-32" />
              </div>
            </div>
          ))}
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState icon={Forward} title={t.emptyTitle} action={add}>
            {t.emptyText}
          </EmptyState>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-border" data-testid="alias-list">
            {list.map((a) => (
              <AliasRow key={a.id} a={a} onEdit={() => setDialog({ alias: a })} onDelete={() => (del.reset(), setDeleting(a))} />
            ))}
          </ul>
        </Card>
      )}
      {dialog && <AliasDialog domain={domain} alias={dialog.alias} hasCatchAll={hasCatchAll} suggestions={suggestions} onClose={() => setDialog(null)} />}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        icon={<Trash2 />}
        tone="destructive"
        title={deleting ? t.deleteTitle(deleting.address) : ""}
        description={t.deleteText}
        actionLabel={t.deleteGo}
        pending={del.isPending}
        error={del.error}
        onConfirm={() => deleting && del.mutate({ id: deleting.id })}
      />
    </div>
  );
}
