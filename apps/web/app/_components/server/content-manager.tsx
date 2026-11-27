"use client";
import { Download, PackageOpen, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { ContentHit, ContentUpdate, InstalledContent, ModpackResult, ServerDetail } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

const compact = (n: number) => new Intl.NumberFormat("en", { notation: "compact" }).format(n);
type Source = ContentHit["source"];

/** Plugins/Mods tab of a Minecraft server: installed items, search and one-click install, modpack import. */
export function ContentManager({ server }: { server: ServerDetail }) {
  const t = useT();
  const c = t.content;
  const info = trpc.content.info.useQuery({ uuid: server.uuid });
  if (info.error) return <QueryError error={info.error} />;
  if (!info.data) return <Skeleton className="h-64 rounded-xl" />;
  const i = info.data;
  if (!i.supported || !i.kind) return <p className="text-sm text-muted-foreground">{c.notSupported}</p>;
  const canWrite = server.permissions.includes("files.write");
  const kindName = i.kind === "plugin" ? c.tabPlugins.toLowerCase() : c.tabMods.toLowerCase();
  return (
    <div className="max-w-4xl space-y-6" data-testid="content-manager">
      <p className="text-sm text-muted-foreground">{c.intro(kindName, i.directory ?? "", i.gameVersion)}</p>
      <InstalledCard server={server} canWrite={canWrite} />
      {canWrite && <SearchCard server={server} sources={i.sources} />}
      {canWrite && i.modpacks && server.isOwner && <ModpackCard server={server} />}
    </div>
  );
}

function InstalledCard({ server, canWrite }: { server: ServerDetail; canWrite: boolean }) {
  const t = useT();
  const c = t.content;
  const utils = trpc.useUtils();
  const list = trpc.content.list.useQuery({ uuid: server.uuid });
  const [updates, setUpdates] = useState<ContentUpdate[] | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);
  const check = trpc.content.checkUpdates.useQuery({ uuid: server.uuid }, { enabled: false });
  const refresh = () => {
    setUpdates(null);
    void utils.content.list.invalidate({ uuid: server.uuid });
  };
  const update = trpc.content.update.useMutation({ onSuccess: refresh });
  const uninstall = trpc.content.uninstall.useMutation({ onSuccess: () => (setConfirm(null), refresh()) });
  const busy = update.isPending || uninstall.isPending;
  const upd = (it: InstalledContent) => updates?.find((u) => u.id === it.id);
  return (
    <Card data-testid="content-installed">
      <CardHeader>
        <CardTitle className="text-base">{c.installedTitle}</CardTitle>
        <CardDescription>{c.restartHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.error ? (
          <QueryError error={list.error} />
        ) : !list.data ? (
          <Skeleton className="h-16 rounded-xl" />
        ) : list.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{c.installedEmpty}</p>
        ) : (
          <>
            {canWrite && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={check.isFetching}
                  onClick={async () => setUpdates((await check.refetch()).data ?? [])}
                >
                  {check.isFetching ? <Spinner /> : <RefreshCw />} {check.isFetching ? c.checking : c.checkUpdates}
                </Button>
                {updates && <span className="text-sm text-muted-foreground" role="status">{updates.length ? c.updatesFound(updates.length) : c.upToDate}</span>}
              </div>
            )}
            <ul className="divide-y divide-border rounded-lg border border-border">
              {list.data.map((it) => {
                const u = upd(it);
                return (
                  <li key={it.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3" data-testid="content-installed-row">
                    <div className="min-w-48 flex-1">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        {it.name}
                        <Badge variant="outline">{it.source === "modrinth" ? c.sourceModrinth : c.sourceHangar}</Badge>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {c.version} {it.versionNumber} · <code className="font-mono">{it.filename}</code>
                      </div>
                    </div>
                    {canWrite && (
                      <div className="flex items-center gap-2">
                        {u && (
                          <Button size="sm" disabled={busy} onClick={() => update.mutate({ uuid: server.uuid, id: it.id })} aria-label={`${it.name}: ${c.updateTo(u.versionNumber)}`}>
                            {update.isPending && update.variables?.id === it.id ? <Spinner /> : <Download />} {c.updateTo(u.versionNumber)}
                          </Button>
                        )}
                        {confirm === it.id ? (
                          <>
                            <Button size="sm" variant="destructive" disabled={busy} onClick={() => uninstall.mutate({ uuid: server.uuid, id: it.id })}>
                              {c.confirmUninstall}
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                              {t.common.cancel}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(it.id)} aria-label={c.uninstallX(it.name)}>
                            <Trash2 /> {c.uninstall}
                          </Button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {(update.error || uninstall.error) && <p className="text-sm text-destructive">{errorText(update.error ?? uninstall.error)}</p>}
      </CardContent>
    </Card>
  );
}

function SearchCard({ server, sources }: { server: ServerDetail; sources: Source[] }) {
  const t = useT();
  const c = t.content;
  const [source, setSource] = useState<Source>(sources[0] ?? "modrinth");
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [earlier, setEarlier] = useState<ContentHit[]>([]);
  const [picked, setPicked] = useState<ContentHit | null>(null);
  const installed = trpc.content.list.useQuery({ uuid: server.uuid });
  const res = trpc.content.search.useQuery({ uuid: server.uuid, source, query, offset }, { retry: false });
  const reset = (s: Source, q: string) => (setSource(s), setQuery(q), setOffset(0), setEarlier([]));
  const hits = [...earlier, ...(res.data?.hits ?? [])];
  const has = (h: ContentHit) => installed.data?.some((x) => x.source === h.source && x.projectId === h.projectId);
  return (
    <Card data-testid="content-search">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Search className="size-4" /> {c.searchLabel}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            reset(source, text.trim());
          }}
        >
          {sources.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="content-source">{c.sourceLabel}</Label>
              <Select id="content-source" className="w-36" value={source} onChange={(e) => reset(e.target.value as Source, query)}>
                {sources.map((s) => (
                  <option key={s} value={s}>
                    {s === "modrinth" ? c.sourceModrinth : c.sourceHangar}
                  </option>
                ))}
              </Select>
            </div>
          )}
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor="content-query">{c.searchLabel}</Label>
            <Input id="content-query" value={text} placeholder={c.searchPlaceholder} onChange={(e) => setText(e.target.value)} />
          </div>
          <Button type="submit">{c.searchButton}</Button>
        </form>

        {res.error ? (
          <QueryError error={res.error} />
        ) : hits.length === 0 && res.isFetching ? (
          <Skeleton className="h-32 rounded-xl" />
        ) : hits.length === 0 ? (
          <p className="text-sm text-muted-foreground">{c.noResults}</p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {hits.map((h) => (
              <li key={`${h.source}:${h.projectId}`} className="flex items-start gap-3 p-3" data-testid="content-hit">
                {h.iconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={h.iconUrl} alt="" className="size-10 shrink-0 rounded-md bg-muted object-cover" loading="lazy" referrerPolicy="no-referrer" />
                ) : (
                  <div className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                    <PackageOpen className="size-5" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <a href={h.url} target="_blank" rel="noreferrer noopener" className="font-medium hover:underline">
                      {h.name}
                    </a>
                    <span className="text-xs text-muted-foreground">{c.by(h.author)}</span>
                    <span className="text-xs text-muted-foreground">{c.downloads(compact(h.downloads))}</span>
                  </div>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{h.description}</p>
                </div>
                {has(h) ? (
                  <Badge variant="outline">{c.installed}</Badge>
                ) : (
                  <Button size="sm" onClick={() => setPicked(h)} aria-label={c.installX(h.name)}>
                    <Download /> {c.install}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {res.data && hits.length < res.data.total && res.data.hits.length > 0 && (
          <Button variant="outline" size="sm" disabled={res.isFetching} onClick={() => (setEarlier(hits), setOffset(hits.length))}>
            {res.isFetching && <Spinner />} {c.loadMore}
          </Button>
        )}
        {picked && <InstallDialog server={server} hit={picked} onClose={() => setPicked(null)} />}
      </CardContent>
    </Card>
  );
}

function InstallDialog({ server, hit, onClose }: { server: ServerDetail; hit: ContentHit; onClose: () => void }) {
  const t = useT();
  const c = t.content;
  const utils = trpc.useUtils();
  const resolved = trpc.content.resolve.useQuery({ uuid: server.uuid, source: hit.source, projectId: hit.projectId }, { retry: false });
  const [withDeps, setWithDeps] = useState(true);
  const [done, setDone] = useState<number | null>(null);
  const install = trpc.content.install.useMutation({
    onSuccess: (r) => {
      setDone(r.length);
      void utils.content.list.invalidate({ uuid: server.uuid });
    },
  });
  const missing = resolved.data?.dependencies.filter((d) => !d.installed) ?? [];
  return (
    <div role="dialog" aria-label={c.dialogTitle(hit.name)} className="space-y-3 rounded-lg border border-border bg-muted/30 p-4" data-testid="content-dialog">
      <h3 className="text-sm font-medium">{c.dialogTitle(hit.name)}</h3>
      {resolved.error ? (
        <QueryError error={resolved.error} />
      ) : !resolved.data ? (
        <Skeleton className="h-12 rounded-md" />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{c.dialogVersion(resolved.data.versionNumber, resolved.data.filename)}</p>
          <div className="space-y-1">
            <p className="text-xs font-medium">{c.depsTitle}</p>
            {resolved.data.dependencies.length === 0 ? (
              <p className="text-xs text-muted-foreground">{c.depsNone}</p>
            ) : (
              <ul className="text-sm">
                {resolved.data.dependencies.map((d) => (
                  <li key={d.projectId}>
                    {d.name} {d.installed && <span className="text-xs text-muted-foreground">({c.depsInstalled})</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {missing.length > 0 && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={withDeps} onChange={(e) => setWithDeps(e.target.checked)} /> {c.depsInstall}
            </label>
          )}
        </>
      )}
      {install.error && <p className="text-sm text-destructive">{errorText(install.error)}</p>}
      {done !== null && (
        <p className="text-sm text-success" role="status">
          {c.installedOk(done)} {c.restartHint}
        </p>
      )}
      <div className="flex gap-2">
        {done === null && (
          <Button
            disabled={!resolved.data || install.isPending}
            onClick={() => install.mutate({ uuid: server.uuid, source: hit.source, projectId: hit.projectId, withDependencies: withDeps && missing.length > 0 })}
          >
            {install.isPending ? <Spinner /> : <Download />} {install.isPending ? c.installing : c.install}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          {done === null ? t.common.cancel : t.common.close}
        </Button>
      </div>
    </div>
  );
}

/** Modpack import (Fabric): by Modrinth search or a .mrpack that is already on the server. */
function ModpackCard({ server }: { server: ServerDetail }) {
  const t = useT();
  const c = t.content;
  const utils = trpc.useUtils();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [path, setPath] = useState("");
  const [reinstall, setReinstall] = useState(true);
  const [pending, setPending] = useState<{ label: string; source: { type: "modrinth"; projectId: string } | { type: "file"; path: string } } | null>(null);
  const [result, setResult] = useState<ModpackResult | null>(null);
  const res = trpc.content.search.useQuery({ uuid: server.uuid, source: "modrinth", query, modpacks: true }, { retry: false });
  const imp = trpc.content.importModpack.useMutation({
    onSuccess: (r) => {
      setResult(r);
      setPending(null);
      void utils.servers.get.invalidate({ uuid: server.uuid });
    },
  });
  useEffect(() => imp.reset(), [pending]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card data-testid="content-modpacks">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PackageOpen className="size-4" /> {c.modpackTitle}
        </CardTitle>
        <CardDescription>{c.modpackIntro}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => (e.preventDefault(), setQuery(text.trim()))}>
          <div className="min-w-48 flex-1 space-y-1.5">
            <Label htmlFor="modpack-query">{c.modpackSearch}</Label>
            <Input id="modpack-query" value={text} placeholder={c.searchPlaceholder} onChange={(e) => setText(e.target.value)} />
          </div>
          <Button type="submit" variant="outline">
            {c.searchButton}
          </Button>
        </form>
        {res.error ? (
          <QueryError error={res.error} />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {(res.data?.hits ?? []).map((h) => (
              <li key={h.projectId} className="flex items-center gap-3 p-3 text-sm" data-testid="modpack-hit">
                <div className="min-w-0 flex-1">
                  <span className="font-medium">{h.name}</span> <span className="text-xs text-muted-foreground">{c.by(h.author)} · {c.downloads(compact(h.downloads))}</span>
                  <p className="line-clamp-1 text-xs text-muted-foreground">{h.description}</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setPending({ label: h.name, source: { type: "modrinth", projectId: h.projectId } })} aria-label={c.modpackImportX(h.name)}>
                  {c.modpackImport}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="modpack-file">{c.modpackFile}</Label>
          <div className="flex gap-2">
            <Input id="modpack-file" value={path} placeholder={c.modpackFilePlaceholder} onChange={(e) => setPath(e.target.value)} className="font-mono" />
            <Button variant="outline" disabled={!/\.mrpack$/i.test(path)} onClick={() => setPending({ label: path, source: { type: "file", path: path.startsWith("/") ? path : `/${path}` } })}>
              {c.modpackImport}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{c.modpackFileHint}</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={reinstall} onChange={(e) => setReinstall(e.target.checked)} /> {c.modpackReinstall}
        </label>
        {pending && (
          <Alert variant="warning" role="alertdialog" data-testid="modpack-confirm">
            <div className="space-y-2">
              <AlertTitle>{c.modpackConfirm}</AlertTitle>
              <AlertDescription>
                <p>
                  <strong>{pending.label}</strong>. {c.modpackConfirmText}
                </p>
              </AlertDescription>
              {imp.error && <p className="text-sm text-destructive">{errorText(imp.error)}</p>}
              <div className="flex gap-2">
                <Button disabled={imp.isPending} onClick={() => imp.mutate({ uuid: server.uuid, source: pending.source, reinstall })}>
                  {imp.isPending && <Spinner />} {c.modpackImport}
                </Button>
                <Button variant="ghost" onClick={() => setPending(null)} disabled={imp.isPending}>
                  {t.common.cancel}
                </Button>
              </div>
            </div>
          </Alert>
        )}
        {result && (
          <p className="text-sm text-success" role="status">
            {c.modpackDone(result.name, result.minecraftVersion, result.filesInstalled, result.filesSkipped)} {result.reinstalled && c.modpackReinstalled}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
