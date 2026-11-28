"use client";
/** Incrementele backups (restic): instellingen (standaardsoort + retentie) en de snapshotbrowser. */
import { ArrowUp, File, Folder, Link2, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import type { Backup, BackupKind, BackupRetention } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Alert } from "@/app/_components/ui/alert";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatBytes, formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

export function BackupSettingsCard({ uuid, canEdit }: { uuid: string; canEdit: boolean }) {
  const t = useT();
  const s = t.backupsInc;
  const utils = trpc.useUtils();
  const q = trpc.backups.settings.useQuery({ uuid });
  const [kind, setKind] = useState<BackupKind>("full");
  const [ret, setRet] = useState<BackupRetention>({ keepLast: 10, keepDaily: 7, keepWeekly: 4 });
  useEffect(() => {
    if (q.data) {
      setKind(q.data.defaultKind);
      setRet(q.data.retention);
    }
  }, [q.data]);
  const save = trpc.backups.updateSettings.useMutation({ onSuccess: (d) => utils.backups.settings.setData({ uuid }, d) });
  if (q.error) return <QueryError error={q.error} />;
  if (!q.data) return <Skeleton className="h-32 rounded-xl" />;
  const empty = ret.keepLast + ret.keepDaily + ret.keepWeekly < 1;
  const num = (k: keyof BackupRetention, label: string) => (
    <div className="w-36 space-y-1">
      <Label htmlFor={`ret-${k}`}>{label}</Label>
      <Input id={`ret-${k}`} type="number" min={0} max={1000} value={ret[k]} disabled={!canEdit} onChange={(e) => setRet({ ...ret, [k]: Math.max(0, Math.min(1000, Number(e.target.value) || 0)) })} />
    </div>
  );
  return (
    <Card data-testid="backup-settings">
      <CardHeader>
        <CardTitle className="text-base">{s.settingsTitle}</CardTitle>
        <CardDescription>{s.settingsText}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!empty) save.mutate({ uuid, defaultKind: kind, retention: ret });
          }}
        >
          <div className="w-48 space-y-1">
            <Label htmlFor="backup-default-kind">{s.defaultKind}</Label>
            <Select id="backup-default-kind" value={kind} disabled={!canEdit} onChange={(e) => setKind(e.target.value as BackupKind)}>
              <option value="full">{s.kind.full}</option>
              <option value="incremental">{s.kind.incremental}</option>
            </Select>
          </div>
          {num("keepLast", s.keepLast)}
          {num("keepDaily", s.keepDaily)}
          {num("keepWeekly", s.keepWeekly)}
          {canEdit && (
            <Button type="submit" variant="outline" disabled={save.isPending || empty}>
              {save.isPending && <Spinner />} {s.save}
            </Button>
          )}
        </form>
        {empty && <p className="mt-3 text-sm text-destructive">{s.retentionEmpty}</p>}
        {q.data.lastPruneAt && <p className="mt-3 text-xs text-muted-foreground">{s.lastPrune(formatDate(q.data.lastPruneAt))}</p>}
        {save.error && <p className="mt-3 text-sm text-destructive">{errorText(save.error)}</p>}
        {save.isSuccess && <p className="mt-3 text-sm text-success">{s.saved}</p>}
      </CardContent>
    </Card>
  );
}

const ICON = { dir: Folder, file: File, symlink: Link2, other: File } as const;

/** Bladeren door een snapshot, paden kiezen en terugzetten (op hun plek of in /restore-<datum>/). */
export function SnapshotBrowser({ uuid, backup: b, onClose }: { uuid: string; backup: Backup; onClose: () => void }) {
  const t = useT();
  const s = t.backupsInc;
  const utils = trpc.useUtils();
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dest, setDest] = useState<"original" | "subdir">("subdir");
  const q = trpc.backups.browse.useQuery({ id: b.id, path }, { staleTime: 60_000 });
  const restore = trpc.backups.restoreFiles.useMutation({
    onSuccess: () => {
      setSelected(new Set());
      void utils.backups.list.invalidate({ uuid });
    },
  });
  const toggle = (p: string) => {
    const next = new Set(selected);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setSelected(next);
  };
  const crumbs = path ? path.split("/") : [];
  return (
    <div className="mt-3 space-y-3 rounded-lg border border-border p-3" data-testid="snapshot-browser" role="region" aria-label={s.browserTitle(b.name)}>
      <div className="flex flex-wrap items-center gap-1 text-sm">
        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setPath("")}>
          {s.root}
        </Button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>
              {c}
            </Button>
          </span>
        ))}
        {path && (
          <Button size="sm" variant="ghost" className="ml-auto h-7 px-2" onClick={() => setPath(crumbs.slice(0, -1).join("/"))}>
            <ArrowUp /> {s.up}
          </Button>
        )}
      </div>
      {q.error ? (
        <QueryError error={q.error} />
      ) : !q.data ? (
        <Skeleton className="h-24 rounded-lg" />
      ) : q.data.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{s.emptyDir}</p>
      ) : (
        <ul className="max-h-80 divide-y divide-border overflow-y-auto text-sm">
          {q.data.entries.map((e) => {
            const Icon = ICON[e.type];
            return (
              <li key={e.path} className="flex items-center gap-2 py-1.5" data-testid="snapshot-entry">
                <Checkbox aria-label={s.select(e.name)} checked={selected.has(e.path)} onChange={() => toggle(e.path)} />
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                {e.type === "dir" ? (
                  <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => setPath(e.path)}>
                    {e.name}
                  </button>
                ) : (
                  <span className="min-w-0 flex-1 truncate">{e.name}</span>
                )}
                {e.type === "file" && <span className="text-xs text-muted-foreground">{formatBytes(e.sizeBytes)}</span>}
              </li>
            );
          })}
        </ul>
      )}
      {q.data?.truncated && <p className="text-xs text-muted-foreground">{s.truncated}</p>}
      {selected.size > 0 && (
        <Alert variant="warning">
          <div className="space-y-2">
            <div className="text-sm font-medium">{s.selected(selected.size)}</div>
            <div className="w-full max-w-sm space-y-1">
              <Label htmlFor={`dest-${b.id}`}>{s.destination}</Label>
              <Select id={`dest-${b.id}`} value={dest} onChange={(e) => setDest(e.target.value as "original" | "subdir")}>
                <option value="subdir">{s.destSubdir}</option>
                <option value="original">{s.destOriginal}</option>
              </Select>
            </div>
            <p className="text-sm">{s.restoreFilesWarn}</p>
            <Button size="sm" variant={dest === "original" ? "destructive" : "default"} disabled={restore.isPending} onClick={() => restore.mutate({ id: b.id, paths: [...selected], destination: dest })}>
              {restore.isPending ? <Spinner /> : <RotateCcw />} {s.restoreSelected}
            </Button>
          </div>
        </Alert>
      )}
      {restore.isSuccess && <p className="text-sm text-success">{s.restoreFilesStarted(restore.data.directory)}</p>}
      {restore.error && <p className="text-sm text-destructive">{errorText(restore.error)}</p>}
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={onClose}>
          {s.close}
        </Button>
      </div>
    </div>
  );
}
