"use client";
import { Archive, Database as DbIcon, Download, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Backup, Permission } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Alert } from "@/app/_components/ui/alert";
import { Badge, type BadgeVariant } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatBytes, formatDate, formatDuration } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

const ACTIVE = new Set<Backup["status"]>(["pending", "running", "restoring"]);
const VARIANT: Record<Backup["status"], BadgeVariant> = { pending: "secondary", running: "info", completed: "success", failed: "destructive", restoring: "warning" };

export function BackupManager({ uuid, permissions }: { uuid: string; permissions: Permission[] }) {
  const t = useT();
  const canCreate = permissions.includes("backup.create");
  const canRestore = permissions.includes("backup.restore");
  // Zolang er iets loopt, elke 2 s verversen (de daemon meldt het resultaat aan het panel).
  const list = trpc.backups.list.useQuery({ uuid }, { refetchInterval: (q) => (q.state.data?.some((b) => ACTIVE.has(b.status)) ? 2000 : false) });
  return (
    <div className="max-w-4xl space-y-6" data-testid="backup-manager">
      {canCreate && <CreateBackup uuid={uuid} />}
      {list.error ? (
        <QueryError error={list.error} />
      ) : !list.data ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : list.data.length === 0 ? (
        <Card className="grid min-h-32 place-items-center p-6 text-sm text-muted-foreground">{t.backups.empty}</Card>
      ) : (
        <div className="grid gap-3">
          {list.data.map((b) => (
            <BackupRow key={b.id} uuid={uuid} backup={b} canCreate={canCreate} canRestore={canRestore} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreateBackup({ uuid }: { uuid: string }) {
  const t = useT();
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [withDb, setWithDb] = useState(true);
  const create = trpc.backups.create.useMutation({
    onSuccess: () => {
      setName("");
      void utils.backups.list.invalidate({ uuid });
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t.backups.createTitle}</CardTitle>
        <CardDescription>{t.backups.createText}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate({ uuid, name: name.trim() || null, includeDatabases: withDb });
          }}
        >
          <div className="min-w-56 flex-1 space-y-1">
            <Label htmlFor="backup-name">{t.backups.name}</Label>
            <Input id="backup-name" value={name} maxLength={100} placeholder={t.backups.namePlaceholder} onChange={(e) => setName(e.target.value)} />
          </div>
          <Label className="flex h-9 items-center gap-2 font-normal">
            <Checkbox checked={withDb} onChange={(e) => setWithDb(e.target.checked)} /> {t.backups.includeDatabases}
          </Label>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? <Spinner /> : <Plus />} {t.backups.create}
          </Button>
        </form>
        {create.error && <p className="mt-3 text-sm text-destructive">{errorText(create.error)}</p>}
        {create.isSuccess && <p className="mt-3 text-sm text-success">{t.backups.created}</p>}
      </CardContent>
    </Card>
  );
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function BackupRow({ uuid, backup: b, canCreate, canRestore }: { uuid: string; backup: Backup; canCreate: boolean; canRestore: boolean }) {
  const t = useT();
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState<null | "restore" | "delete">(null);
  const active = ACTIVE.has(b.status);
  const now = useNow(active);
  const refresh = () => void utils.backups.list.invalidate({ uuid });
  const restore = trpc.backups.restore.useMutation({ onSuccess: () => (setConfirm(null), refresh()) });
  const del = trpc.backups.delete.useMutation({ onSuccess: () => (setConfirm(null), refresh()) });
  const download = trpc.backups.downloadUrl.useMutation({
    onSuccess: (r) => {
      // De gesigneerde S3-url opent als download (10 minuten geldig).
      const a = document.createElement("a");
      a.href = r.url;
      a.rel = "noreferrer";
      a.click();
    },
  });
  const done = b.status === "completed";
  const err = restore.error ?? del.error ?? download.error;
  return (
    <Card data-testid="backup-row" className="p-4">
      <div className="flex flex-wrap items-center gap-3">
        <Archive className="size-4 text-muted-foreground" />
        <div className="min-w-0 flex-1 basis-[10rem]">
          <div className="truncate font-medium">{b.name}</div>
          <div className="text-xs text-muted-foreground">
            {formatDate(b.createdAt)}
            {b.sizeBytes != null && ` · ${formatBytes(b.sizeBytes)}`}
            {b.includesDatabases && (
              <>
                {" · "}
                <DbIcon className="inline size-3" /> {t.backups.withDatabases}
              </>
            )}
          </div>
          {b.sha256 && (
            <div className="truncate font-mono text-[11px] text-muted-foreground" title={b.sha256}>
              {t.backups.checksum}: {b.sha256}
            </div>
          )}
          {b.status === "failed" && b.error && (
            <div className="break-words text-xs text-destructive" data-testid="backup-error">
              {t.backups.failedReason}: {b.error}
            </div>
          )}
        </div>
        <Badge variant={VARIANT[b.status]}>{t.backups.status[b.status]}</Badge>
        {done && canRestore && (
          <Button size="sm" variant="outline" disabled={download.isPending} onClick={() => download.mutate({ id: b.id })}>
            {download.isPending ? <Spinner /> : <Download />} {t.backups.download}
          </Button>
        )}
        {done && canRestore && confirm !== "restore" && (
          <Button size="sm" variant="outline" onClick={() => setConfirm("restore")}>
            <RotateCcw /> {t.backups.restore}
          </Button>
        )}
        {!active && canCreate && confirm !== "delete" && (
          <Button size="sm" variant="outline" className="text-destructive" aria-label={`${t.backups.delete} ${b.name}`} onClick={() => setConfirm("delete")}>
            <Trash2 />
          </Button>
        )}
      </div>
      {active && (
        <div className="mt-3 space-y-1">
          <div role="progressbar" aria-label={t.backups.status[b.status]} className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
          </div>
          <div className="text-xs text-muted-foreground">{t.backups.runningFor(formatDuration(Math.max(0, now - b.createdAt.getTime())))}</div>
        </div>
      )}
      {confirm === "restore" && (
        <Alert variant="warning" className="mt-3" role="alertdialog" aria-label={t.backups.restoreTitle(b.name)}>
          <div className="space-y-3">
            <div className="font-medium">{t.backups.restoreTitle(b.name)}</div>
            <p className="text-sm">
              {t.backups.restoreWarn} {b.includesDatabases && t.backups.restoreWarnDb}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" disabled={restore.isPending} onClick={() => restore.mutate({ id: b.id })}>
                {restore.isPending && <Spinner />} {t.backups.restoreConfirm}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        </Alert>
      )}
      {confirm === "delete" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-destructive">{t.backups.deleteWarn}</span>
          <Button size="sm" variant="destructive" disabled={del.isPending} onClick={() => del.mutate({ id: b.id })}>
            {del.isPending && <Spinner />} {t.common.delete}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
            {t.common.cancel}
          </Button>
        </div>
      )}
      {restore.isSuccess && <p className="mt-3 text-sm text-success">{t.backups.restoreStarted}</p>}
      {err && <p className="mt-3 text-sm text-destructive">{errorText(err)}</p>}
    </Card>
  );
}
