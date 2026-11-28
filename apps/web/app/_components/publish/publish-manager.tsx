"use client";
import { AlertTriangle, CheckCircle2, Circle, GitCompareArrows, Layers, Loader2, MinusCircle, Rocket, XCircle } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { PublishInfo, PublishJob, ServerDetail } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CloneProgress } from "@/app/_components/server/clone-card";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/app/_components/ui/dialog";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";

const HOST = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
/** Zelfde regels als de daemon (internal/publish.Compile). */
const validExclude = (p: string) => p.length <= 512 && !/[\\\0]/.test(p) && !p.includes("**") && p.replace(/^\/+|\/+$/g, "").split("/").every((s) => s !== "" && s !== "." && s !== "..");

function useReason() {
  const p = useT().publish;
  return (reason: string | null) => {
    if (!reason) return null;
    const m = /^MISSING_PERMISSION: (.+)$/.exec(reason);
    if (m) return p.reasons.missing(m[1]!);
    return (p.reasons as Record<string, unknown>)[reason] as string | undefined ?? reason;
  };
}

/** Melding bovenaan een staging-site: "Staging van <productie>", met een link naar publiceren. */
export function StagingBanner({ server }: { server: ServerDetail }) {
  const p = useT().publish;
  const q = trpc.publish.info.useQuery({ uuid: server.uuid }, { enabled: server.type === "web", retry: false, staleTime: 60_000 });
  const prod = q.data?.role === "staging" ? q.data.production : null;
  if (!prod) return null;
  return (
    <Alert data-testid="staging-banner">
      <Layers />
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-2">
        <AlertDescription className="min-w-0 break-words">{p.bannerStaging(prod.name)}</AlertDescription>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link href={`/servers/${prod.uuid}`}>{p.openProduction}</Link>
          </Button>
          <Button size="sm" asChild>
            <Link href={`/servers/${server.uuid}/staging`}>
              <Rocket /> {p.publishButton}
            </Link>
          </Button>
        </div>
      </div>
    </Alert>
  );
}

/** Tabblad "Staging": relatie, publiceren, staging maken en geschiedenis. */
export function PublishManager({ server, canCreate }: { server: ServerDetail; canCreate: boolean }) {
  const t = useT();
  const p = t.publish;
  const reasonText = useReason();
  const info = trpc.publish.info.useQuery({ uuid: server.uuid }, { retry: false, refetchInterval: (q) => (q.state.data?.running ? 3000 : false) });
  const [open, setOpen] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  if (server.type !== "web") return <p className="text-sm text-muted-foreground">{p.notWeb}</p>;
  if (info.error) return <p className="text-sm text-destructive">{errorText(info.error)}</p>;
  if (!info.data)
    return (
      <div className="grid h-40 place-items-center">
        <Spinner />
      </div>
    );
  const i = info.data;
  return (
    <div className="space-y-5" data-testid="publish-manager">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitCompareArrows className="size-4 text-primary" /> {p.title}
          </CardTitle>
          <CardDescription>{p.intro}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {i.role === "staging" && (
            <div className="space-y-3" data-testid="publish-staging">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge variant="secondary">{i.production ? p.stagingOf(i.production.name) : p.reasons.PRODUCTION_NO_ACCESS}</Badge>
                {i.production && (
                  <Link href={`/servers/${i.production.uuid}`} className="text-primary underline-offset-4 hover:underline">
                    {p.openProduction}
                  </Link>
                )}
              </div>
              {i.running ? (
                <PublishProgress id={i.running.id} />
              ) : (
                <div className="space-y-2">
                  <Button onClick={() => (setJobId(null), setOpen(true))} disabled={!i.canPublish} data-testid="publish-open">
                    <Rocket /> {p.publishButton}
                  </Button>
                  {!i.canPublish && i.reason && <p className="text-xs text-muted-foreground" data-testid="publish-reason">{reasonText(i.reason)}</p>}
                </div>
              )}
            </div>
          )}
          {i.stagings.length > 0 && (
            <div className="space-y-2" data-testid="publish-stagings">
              <div className="text-sm font-medium">{p.stagingsTitle}</div>
              <ul className="divide-y divide-border rounded-xl border border-border">
                {i.stagings.map((s) => (
                  <li key={s.uuid} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0">
                      <div className="break-words font-medium">{s.name}</div>
                      <div className="text-xs text-muted-foreground">{s.lastPublishedAt ? p.lastPublished(formatDate(s.lastPublishedAt)) : p.neverPublished}</div>
                    </div>
                    <Button size="sm" variant="outline" asChild>
                      <Link href={`/servers/${s.uuid}/staging`}>{p.openStaging}</Link>
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {i.role === "none" && <p className="text-sm text-muted-foreground">{p.stagingsNone}</p>}
        </CardContent>
      </Card>

      {canCreate && i.role !== "staging" && <CreateStagingCard server={server} />}
      <PublishHistory uuid={server.uuid} />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent closeLabel={t.common.close} className="sm:max-w-2xl" data-testid="publish-dialog">
          <DialogTitle className="pr-10 text-lg font-semibold">{p.dialogTitle(server.name, i.production?.name ?? "")}</DialogTitle>
          <DialogDescription className="mb-4 text-sm text-muted-foreground">{p.downtime}</DialogDescription>
          {open && (jobId ? <PublishProgress id={jobId} /> : <PublishForm server={server} info={i} onStarted={setJobId} />)}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PublishForm({ server, info, onStarted }: { server: ServerDetail; info: PublishInfo; onStarted: (id: number) => void }) {
  const p = useT().publish;
  const utils = trpc.useUtils();
  const [files, setFiles] = useState(true);
  const [databases, setDatabases] = useState(false);
  const [confirmDb, setConfirmDb] = useState(false);
  const [rewrite, setRewrite] = useState(true);
  const [skipBackup, setSkipBackup] = useState(false);
  const [excl, setExcl] = useState<Record<string, boolean>>(() => Object.fromEntries(info.defaultExcludes.map((e) => [e.pattern, true])));
  const [uploadsTouched, setUploadsTouched] = useState(false);
  const [custom, setCustom] = useState("");
  const start = trpc.publish.start.useMutation({
    onSuccess: (j) => {
      void utils.publish.info.invalidate({ uuid: server.uuid });
      void utils.publish.history.invalidate({ uuid: server.uuid });
      onStarted(j.id);
    },
  });
  const customList = custom.split("\n").map((x) => x.trim()).filter(Boolean);
  const customBad = customList.some((x) => !validExclude(x));
  const hasDbs = info.databases.length > 0;
  const kinds = [...new Set(info.defaultExcludes.map((e) => e.kind))];
  const exclude = [...info.defaultExcludes.filter((e) => excl[e.pattern]).map((e) => e.pattern), ...customList];
  const invalid = (!files && !databases) || (databases && (!confirmDb || !hasDbs)) || (!info.backupAvailable && !skipBackup) || customBad;
  const setDb = (on: boolean) => {
    setDatabases(on);
    if (!on) setConfirmDb(false);
    // Uploads horen bij de database: met databases standaard mee, zonder standaard houden.
    if (!uploadsTouched) setExcl((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, info.defaultExcludes.find((e) => e.pattern === k)?.kind === "uploads" ? !on : v])));
  };

  return (
    <form
      className="space-y-4"
      data-testid="publish-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        start.mutate({ uuid: server.uuid, files, databases, confirmDatabases: databases && confirmDb, exclude, rewriteUrls: rewrite, skipBackup: !info.backupAvailable && skipBackup });
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{p.whatTitle}</legend>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={files} onChange={(e) => setFiles(e.target.checked)} className="mt-0.5" data-testid="publish-files" />
          <span className="min-w-0">
            {p.files}
            <span className="block text-xs text-muted-foreground">{p.filesHint}</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={databases} onChange={(e) => setDb(e.target.checked)} disabled={!hasDbs} className="mt-0.5" data-testid="publish-databases" />
          <span className="min-w-0">
            {p.databases}
            <span className="block text-xs text-muted-foreground">{hasDbs ? p.databasesHint : p.dbNone}</span>
            {hasDbs && (
              <span className="block break-all font-mono text-xs text-muted-foreground">
                {info.databases.map((d) => p.dbPair(d.from, d.to)).join(", ")}
              </span>
            )}
            {info.unmatchedDatabases.length > 0 && <span className="block break-all text-xs text-muted-foreground">{p.dbUnmatched(info.unmatchedDatabases.join(", "))}</span>}
          </span>
        </label>
      </fieldset>

      {databases && (
        <Alert variant="destructive" data-testid="publish-db-warning">
          <AlertTriangle />
          <div className="min-w-0 space-y-2">
            <AlertTitle>{p.databasesWarningTitle}</AlertTitle>
            <AlertDescription>{p.databasesWarning}</AlertDescription>
            <label className="flex items-start gap-2 text-sm font-medium">
              <Checkbox checked={confirmDb} onChange={(e) => setConfirmDb(e.target.checked)} className="mt-0.5" data-testid="publish-confirm-db" />
              <span>{p.confirmDatabases}</span>
            </label>
          </div>
        </Alert>
      )}
      {databases &&
        (info.stagingHost && info.productionHost ? (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox checked={rewrite} onChange={(e) => setRewrite(e.target.checked)} className="mt-0.5" data-testid="publish-rewrite" />
            <span className="min-w-0 break-words">
              {p.rewriteUrls(info.stagingHost, info.productionHost)}
              <span className="block text-xs text-muted-foreground">{p.rewriteHint}</span>
            </span>
          </label>
        ) : (
          <p className="text-xs text-muted-foreground">{p.rewriteNoHosts}</p>
        ))}

      {files && (
        <fieldset className="space-y-2 rounded-xl border border-border p-3" data-testid="publish-excludes">
          <legend className="px-1 text-sm font-medium">{p.excludesTitle}</legend>
          <p className="text-xs text-muted-foreground">{p.excludesHint}</p>
          {kinds.map((k) => {
            const pats = info.defaultExcludes.filter((e) => e.kind === k);
            const on = pats.every((e) => excl[e.pattern]);
            return (
              <label key={k} className="flex items-start gap-2 text-sm">
                <Checkbox
                  checked={on}
                  onChange={(e) => {
                    if (k === "uploads") setUploadsTouched(true);
                    setExcl((x) => ({ ...x, ...Object.fromEntries(pats.map((q) => [q.pattern, e.target.checked])) }));
                  }}
                  className="mt-0.5"
                  data-testid={`publish-exclude-${k}`}
                />
                <span className="min-w-0">
                  {p.excludeKinds[k]}
                  <span className="block break-all font-mono text-xs text-muted-foreground">{pats.map((q) => q.pattern).join(", ")}</span>
                  {k === "uploads" && <span className="block text-xs text-muted-foreground">{p.uploadsHint}</span>}
                </span>
              </label>
            );
          })}
          <div className="space-y-1.5">
            <Label htmlFor="publish-custom">{p.customExcludes}</Label>
            <textarea
              id="publish-custom"
              rows={3}
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              spellCheck={false}
              autoCapitalize="none"
              aria-invalid={customBad || undefined}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm"
            />
            <p className={`text-xs ${customBad ? "text-destructive" : "text-muted-foreground"}`}>{customBad ? p.customExcludesBad : p.customExcludesHint}</p>
          </div>
        </fieldset>
      )}

      <div className="space-y-2">
        <div className="text-sm font-medium">{p.backupTitle}</div>
        {info.backupAvailable ? (
          <p className="text-sm text-muted-foreground" data-testid="publish-backup">{p.backup}</p>
        ) : (
          <Alert variant="warning" data-testid="publish-no-backup">
            <AlertTriangle />
            <div className="min-w-0 space-y-2">
              <AlertTitle>{p.noBackupTitle}</AlertTitle>
              <AlertDescription>{p.noBackupText}</AlertDescription>
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox checked={skipBackup} onChange={(e) => setSkipBackup(e.target.checked)} data-testid="publish-skip-backup" /> {p.skipBackup}
              </label>
            </div>
          </Alert>
        )}
      </div>

      {info.notes.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground" data-testid="publish-notes">
          {info.notes.map((n) => (
            <li key={n} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" />
              <span>{p.notes[n]}</span>
            </li>
          ))}
        </ul>
      )}

      {start.error ? <p className="text-sm text-destructive">{errorText(start.error)}</p> : null}
      <Button type="submit" disabled={invalid || start.isPending} className="w-full sm:w-auto" data-testid="publish-submit">
        {start.isPending ? <Spinner /> : <Rocket />} {start.isPending ? p.starting : p.start}
      </Button>
    </form>
  );
}

const StepIcon = ({ s }: { s: PublishJob["steps"][number]["status"] }) =>
  s === "done" ? <CheckCircle2 className="size-4 text-success" /> : s === "running" ? <Loader2 className="size-4 animate-spin text-primary" /> : s === "failed" ? <XCircle className="size-4 text-destructive" /> : s === "skipped" ? <MinusCircle className="size-4 text-muted-foreground/60" /> : <Circle className="size-4 text-muted-foreground" />;

/** Voortgang en uitkomst van één publicatie (pollt zolang hij loopt). */
export function PublishProgress({ id }: { id: number }) {
  const p = useT().publish;
  const utils = trpc.useUtils();
  const q = trpc.publish.job.useQuery({ id }, { refetchInterval: (query) => (query.state.data?.status === "running" ? 1500 : false) });
  const j = q.data;
  const done = !!j && j.status !== "running";
  useEffect(() => {
    if (!done) return;
    void utils.publish.info.invalidate();
    void utils.publish.history.invalidate();
  }, [done, utils]);
  if (q.error) return <p className="text-sm text-destructive">{errorText(q.error)}</p>;
  if (!j)
    return (
      <div className="grid h-32 place-items-center">
        <Spinner />
      </div>
    );
  return (
    <div className="space-y-4" data-testid="publish-progress" data-status={j.status}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 break-words text-sm font-medium">{p.direction(j.staging.name, j.production.name)}</div>
        <Badge variant={j.status === "succeeded" ? "success" : j.status === "running" ? "secondary" : "destructive"}>{p.status[j.status]}</Badge>
      </div>
      <ol className="space-y-2">
        {j.steps
          .filter((s) => s.status !== "skipped")
          .map((s) => (
            <li key={s.key} className="flex items-start gap-2 text-sm" data-testid={`publish-step-${s.key}`} data-status={s.status}>
              <span className="mt-0.5">
                <StepIcon s={s.status} />
              </span>
              <span>{p.steps[s.key]}</span>
            </li>
          ))}
      </ol>
      {j.status === "succeeded" && <p className="text-sm text-success" role="status">{p.succeeded}</p>}
      {j.status === "failed" && (
        <Alert variant="destructive" data-testid="publish-failed">
          <XCircle />
          <div className="min-w-0">
            <AlertTitle>{j.restored === true ? p.failedRestored : j.restored === false ? p.failedNotRestored : p.failedUnchanged}</AlertTitle>
            {j.error && <AlertDescription className="break-words">{j.error}</AlertDescription>}
          </div>
        </Alert>
      )}
      {j.backupId !== null && j.status === "succeeded" && <p className="text-xs text-muted-foreground">{p.backupMade}</p>}
      {j.kept.length > 0 && j.status === "succeeded" && (
        <div className="space-y-1">
          <div className="text-sm font-medium">{p.kept}</div>
          <p className="break-all font-mono text-xs text-muted-foreground">{j.kept.join(", ")}</p>
        </div>
      )}
      {j.urlRewrite && j.status === "succeeded" && <p className="break-words text-xs text-muted-foreground">{p.urlRewrite(j.urlRewrite.replaced, j.urlRewrite.from, j.urlRewrite.to)}</p>}
      {j.warnings.length > 0 && (
        <div className="space-y-1" data-testid="publish-warnings">
          <div className="text-sm font-medium">{p.warnings}</div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {j.warnings.map((w, i) => (
              <li key={i} className="flex gap-1.5 break-words">
                <AlertTriangle className="mt-0.5 size-3 shrink-0 text-warning" /> <span className="min-w-0">{w}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PublishHistory({ uuid }: { uuid: string }) {
  const t = useT();
  const p = t.publish;
  const q = trpc.publish.history.useQuery({ uuid }, { retry: false });
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Card data-testid="publish-history">
      <CardHeader>
        <CardTitle className="text-base">{p.history}</CardTitle>
      </CardHeader>
      <CardContent>
        {q.error ? (
          <p className="text-sm text-destructive">{errorText(q.error)}</p>
        ) : !q.data ? (
          <Spinner />
        ) : q.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">{p.historyEmpty}</p>
        ) : (
          <ul className="divide-y divide-border">
            {q.data.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div className="min-w-0">
                  <div className="break-words">{p.direction(j.staging.name, j.production.name)}</div>
                  <div className="text-xs text-muted-foreground">
                    {formatDate(j.startedAt)} · {p.what(j.options.files, j.options.databases)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={j.status === "succeeded" ? "success" : j.status === "running" ? "secondary" : "destructive"}>{p.status[j.status]}</Badge>
                  <Button size="sm" variant="outline" onClick={() => setOpen(j.id)}>
                    {p.details}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <Dialog open={open !== null} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent closeLabel={t.common.close} className="sm:max-w-xl">
          <DialogTitle className="pr-10 text-lg font-semibold">{p.progressTitle}</DialogTitle>
          <DialogDescription className="sr-only">{p.history}</DialogDescription>
          {open !== null && <PublishProgress id={open} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function CreateStagingCard({ server }: { server: ServerDetail }) {
  const p = useT().publish;
  const utils = trpc.useUtils();
  const [name, setName] = useState(p.createDefaultName(server.name).slice(0, 100));
  const [domain, setDomain] = useState("");
  const [copyDb, setCopyDb] = useState(true);
  const [jobId, setJobId] = useState<number | null>(null);
  const create = trpc.publish.createStaging.useMutation({
    onSuccess: (j) => {
      void utils.servers.list.invalidate();
      void utils.publish.info.invalidate({ uuid: server.uuid });
      setJobId(j.id);
    },
  });
  const domainBad = domain.trim() !== "" && !HOST.test(domain.trim());
  const nameBad = !name.trim();
  return (
    <Card data-testid="create-staging">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Layers className="size-4 text-primary" /> {p.createTitle}
        </CardTitle>
        <CardDescription>{p.createText}</CardDescription>
      </CardHeader>
      <CardContent>
        {jobId ? (
          <div className="space-y-2">
            <div className="text-sm font-medium">{p.createProgress}</div>
            <CloneProgress id={jobId} />
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (domainBad || nameBad) return;
              create.mutate({ uuid: server.uuid, name: name.trim(), copyDatabases: copyDb, domain: domain.trim() ? domain.trim().toLowerCase() : null });
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="staging-name">{p.createName}</Label>
                <Input id="staging-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-invalid={nameBad || undefined} />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="staging-domain">{p.createDomain}</Label>
                <Input id="staging-domain" value={domain} placeholder="staging.example.com" onChange={(e) => setDomain(e.target.value)} aria-invalid={domainBad || undefined} autoCapitalize="none" spellCheck={false} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{p.createDomainHint}</p>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={copyDb} onChange={(e) => setCopyDb(e.target.checked)} className="mt-0.5" />
              <span className="min-w-0">
                {p.createDatabases}
                <span className="block text-xs text-muted-foreground">{p.createDatabasesHint}</span>
              </span>
            </label>
            {create.error ? <p className="text-sm text-destructive">{errorText(create.error)}</p> : null}
            <Button type="submit" disabled={create.isPending || domainBad || nameBad} data-testid="create-staging-submit">
              {create.isPending ? <Spinner /> : <Layers />} {create.isPending ? p.creating : p.createStart}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
