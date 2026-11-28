"use client";
import { ArrowDown, ArrowUp, ExternalLink, Globe, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { StatusCandidate, StatusPage } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/app/_components/ui/dialog";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
/** Voorstel voor een slug uit een naam. */
export const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "");
const origin = () => (typeof window === "undefined" ? "" : window.location.origin);
export const statusUrl = (slug: string) => `${origin()}/status/${slug}`;

function SlugField({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const t = useT();
  const ok = SLUG_RE.test(value);
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{t.statusPage.slug}</Label>
      <Input id={id} value={value} spellCheck={false} autoComplete="off" aria-invalid={!ok || undefined} onChange={(e) => onChange(e.target.value.toLowerCase())} />
      <p className={ok ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>{ok ? t.statusPage.slugHint(statusUrl(value)) : t.errors.messages.INVALID_SLUG}</p>
    </div>
  );
}

// ---------- serverinstellingen ----------

/** Statuspagina van één server (eigenaar/admin). */
export function ServerStatusPageCard({ uuid, name }: { uuid: string; name: string }) {
  const q = trpc.statusPages.serverPage.useQuery({ uuid });
  if (q.isLoading) return null;
  // Key alleen op de server: de eerste keer opslaan geeft de pagina een id, en een remount zou "Opgeslagen" wissen.
  return <ServerStatusPageForm key={uuid} uuid={uuid} name={name} page={q.data ?? null} />;
}

function ServerStatusPageForm({ uuid, name, page }: { uuid: string; name: string; page: StatusPage | null }) {
  const t = useT().statusPage;
  const utils = trpc.useUtils();
  const [enabled, setEnabled] = useState(page?.enabled ?? false);
  const [slug, setSlug] = useState(page?.slug ?? (slugify(name).length >= 3 ? slugify(name) : `server-${uuid.slice(0, 8)}`));
  const [showAddress, setShowAddress] = useState(page?.showAddress ?? false);
  const [showPlayers, setShowPlayers] = useState(page?.showPlayers ?? true);
  const save = trpc.statusPages.setServerPage.useMutation({ onSuccess: (d) => utils.statusPages.serverPage.setData({ uuid }, d) });
  const ok = SLUG_RE.test(slug);
  return (
    <Card data-testid="status-page-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Globe className="size-4 text-muted-foreground" /> {t.serverCardTitle}
        </CardTitle>
        <CardDescription>{t.serverCardText}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save.mutate({ uuid, enabled, slug, showAddress, showPlayers });
          }}
        >
          <label className="flex items-center gap-2 text-sm">
            <Checkbox role="switch" checked={enabled} onChange={(e) => (setEnabled(e.target.checked), save.reset())} /> {t.enabled}
          </label>
          <SlugField id="status-slug" value={slug} onChange={(v) => (setSlug(v), save.reset())} />
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={showAddress} onChange={(e) => (setShowAddress(e.target.checked), save.reset())} />
            <span>
              {t.showAddress}
              <span className="block text-xs text-muted-foreground">{t.showAddressHint}</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={showPlayers} onChange={(e) => (setShowPlayers(e.target.checked), save.reset())} /> {t.showPlayers}
          </label>
          {save.error && <p className="text-sm text-destructive">{errorText(save.error)}</p>}
          {save.isSuccess && (
            <p className="text-sm text-success" role="status">
              {t.saved}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={!ok || save.isPending}>
              {save.isPending && <Spinner />} {t.save}
            </Button>
            {page?.enabled && (
              <Button asChild variant="outline">
                <a href={`/status/${page.slug}`} target="_blank" rel="noopener noreferrer">
                  <ExternalLink /> {t.open}
                </a>
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ---------- netwerkpagina's ----------

interface Draft {
  id: number | null;
  slug: string;
  title: string;
  description: string;
  enabled: boolean;
  showAddress: boolean;
  showPlayers: boolean;
  servers: string[];
}

const emptyDraft: Draft = { id: null, slug: "", title: "", description: "", enabled: true, showAddress: false, showPlayers: true, servers: [] };

/** Overzicht van eigen statuspagina's met maken/bewerken/verwijderen. */
export function StatusPagesManager() {
  const t = useT().statusPage;
  const utils = trpc.useUtils();
  const pages = trpc.statusPages.list.useQuery();
  const cands = trpc.statusPages.candidates.useQuery();
  const del = trpc.statusPages.delete.useMutation({ onSuccess: () => void utils.statusPages.list.invalidate() });
  const [draft, setDraft] = useState<Draft | null>(null);
  if (!pages.data || !cands.data) return <Skeleton className="h-40 rounded-xl" />;
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setDraft({ ...emptyDraft })} data-testid="new-status-page">
          <Plus /> {t.newPage}
        </Button>
      </div>
      {!pages.data.length && (
        <EmptyState icon={Globe} title={t.empty}>
          {t.emptyText}
        </EmptyState>
      )}
      <ul className="space-y-3">
        {pages.data.map((p) => (
          <li key={p.id}>
            <Card data-testid="status-page-row">
              <CardContent className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{p.title}</span>
                    <Badge variant="secondary">{p.kind === "server" ? t.kindServer : t.kindNetwork}</Badge>
                    {!p.enabled && <Badge variant="warning">{t.off}</Badge>}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    /status/{p.slug} · {p.servers.map((s) => s.name).join(", ")}
                  </div>
                </div>
                {p.enabled && (
                  <Button asChild variant="outline" size="sm">
                    <a href={`/status/${p.slug}`} target="_blank" rel="noopener noreferrer">
                      <ExternalLink /> {t.open}
                    </a>
                  </Button>
                )}
                {p.kind === "network" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${t.editPage}: ${p.title}`}
                    onClick={() => setDraft({ id: p.id, slug: p.slug, title: p.title, description: p.description ?? "", enabled: p.enabled, showAddress: p.showAddress, showPlayers: p.showPlayers, servers: p.servers.map((s) => s.uuid) })}
                  >
                    <Pencil />
                  </Button>
                )}
                <Button variant="ghost" size="sm" aria-label={`${t.delete}: ${p.title}`} disabled={del.isPending} onClick={() => window.confirm(t.deleteConfirm(p.title)) && del.mutate({ id: p.id })}>
                  <Trash2 />
                </Button>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>
      {draft && <PageDialog draft={draft} candidates={cands.data} onClose={() => setDraft(null)} />}
    </div>
  );
}

function PageDialog({ draft: initial, candidates, onClose }: { draft: Draft; candidates: StatusCandidate[]; onClose: () => void }) {
  const t = useT();
  const s = t.statusPage;
  const utils = trpc.useUtils();
  const [d, setD] = useState(initial);
  const [slugTouched, setSlugTouched] = useState(initial.id !== null);
  const done = () => (void utils.statusPages.list.invalidate(), onClose());
  const create = trpc.statusPages.create.useMutation({ onSuccess: done });
  const update = trpc.statusPages.update.useMutation({ onSuccess: done });
  const err = create.error ?? update.error;
  const byUuid = new Map(candidates.map((c) => [c.uuid, c]));
  const add = (uuids: string[]) => setD((x) => ({ ...x, servers: [...x.servers, ...uuids.filter((u) => !x.servers.includes(u))] }));
  const move = (i: number, by: number) =>
    setD((x) => {
      const a = [...x.servers];
      const [it] = a.splice(i, 1);
      a.splice(i + by, 0, it!);
      return { ...x, servers: a };
    });
  const valid = SLUG_RE.test(d.slug) && d.title.trim().length > 0 && d.servers.length > 0;
  const input = { slug: d.slug, title: d.title.trim(), description: d.description.trim() || null, enabled: d.enabled, showAddress: d.showAddress, showPlayers: d.showPlayers, serverUuids: d.servers };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent closeLabel={t.common.close} className="max-h-[90dvh] overflow-y-auto">
        <DialogTitle>{d.id ? s.editPage : s.newPage}</DialogTitle>
        <DialogDescription>{s.pageText}</DialogDescription>
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            if (d.id) update.mutate({ id: d.id, ...input });
            else create.mutate(input);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="sp-title">{s.title}</Label>
            <Input id="sp-title" value={d.title} maxLength={100} onChange={(e) => setD({ ...d, title: e.target.value, slug: slugTouched ? d.slug : slugify(e.target.value) })} />
          </div>
          <SlugField id="sp-slug" value={d.slug} onChange={(v) => (setSlugTouched(true), setD({ ...d, slug: v }))} />
          <div className="space-y-1.5">
            <Label htmlFor="sp-desc">{s.description}</Label>
            <Input id="sp-desc" value={d.description} maxLength={500} onChange={(e) => setD({ ...d, description: e.target.value })} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{s.servers}</legend>
            <p className="text-xs text-muted-foreground">{s.serversHint}</p>
            <ol className="space-y-1">
              {d.servers.map((u, i) => (
                <li key={u} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-sm" data-testid="sp-server">
                  <span className="min-w-0 flex-1 truncate">{byUuid.get(u)?.name ?? u.slice(0, 8)}</span>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={s.moveUp} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={s.moveDown} disabled={i === d.servers.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={`${s.remove}: ${byUuid.get(u)?.name ?? u}`} onClick={() => setD({ ...d, servers: d.servers.filter((x) => x !== u) })}>
                    <X />
                  </Button>
                </li>
              ))}
            </ol>
            <Select aria-label={s.pickServer} value="" onChange={(e) => e.target.value && add([e.target.value])}>
              <option value="">{s.pickServer}</option>
              {candidates
                .filter((c) => !d.servers.includes(c.uuid))
                .map((c) => (
                  <option key={c.uuid} value={c.uuid}>
                    {c.name} ({c.templateName})
                  </option>
                ))}
            </Select>
            <div className="flex flex-wrap gap-2">
              {candidates
                .filter((c) => c.networkMembers.length && d.servers.includes(c.uuid) && c.networkMembers.some((m) => !d.servers.includes(m)))
                .map((c) => (
                  <Button key={c.uuid} type="button" variant="outline" size="sm" title={s.addNetworkHint} onClick={() => add(c.networkMembers)}>
                    {c.name} {s.addNetwork(c.networkMembers.length)}
                  </Button>
                ))}
            </div>
            {!d.servers.length && <p className="text-xs text-muted-foreground">{s.noServers}</p>}
          </fieldset>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox role="switch" checked={d.enabled} onChange={(e) => setD({ ...d, enabled: e.target.checked })} /> {s.enabled}
          </label>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={d.showAddress} onChange={(e) => setD({ ...d, showAddress: e.target.checked })} />
            <span>
              {s.showAddress}
              <span className="block text-xs text-muted-foreground">{s.showAddressHint}</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={d.showPlayers} onChange={(e) => setD({ ...d, showPlayers: e.target.checked })} /> {s.showPlayers}
          </label>
          {err && <p className="text-sm text-destructive">{errorText(err)}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" disabled={!valid || create.isPending || update.isPending}>
              {(create.isPending || update.isPending) && <Spinner />} {s.save}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
