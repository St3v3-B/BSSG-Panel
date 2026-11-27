"use client";
import { AlertTriangle, Check, CircleDashed, ExternalLink, Loader2, PackagePlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AppJob, AppSummary } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Progress } from "@/app/_components/ui/progress";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

export const POLL_MS = 1500;
const USER_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AppsManager({ uuid }: { uuid: string }) {
  const t = useT();
  const catalog = trpc.apps.catalog.useQuery({ uuid });
  const jobs = trpc.apps.jobs.useQuery({ uuid });
  const [selected, setSelected] = useState<string | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);

  // Pick up an installation that is already running (e.g. after a page reload).
  useEffect(() => {
    if (jobId === null && jobs.data) {
      const running = jobs.data.find((j) => j.status === "running");
      if (running) setJobId(running.id);
    }
  }, [jobs.data, jobId]);

  const app = catalog.data?.find((a) => a.id === selected) ?? null;
  return (
    <div className="max-w-4xl space-y-6" data-testid="apps-manager">
      {jobId !== null ? (
        <JobView
          uuid={uuid}
          jobId={jobId}
          onClose={() => {
            setJobId(null);
            setSelected(null);
            void jobs.refetch();
          }}
        />
      ) : app ? (
        <InstallForm uuid={uuid} app={app} onCancel={() => setSelected(null)} onStarted={(id) => setJobId(id)} />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t.apps.title}</CardTitle>
              <CardDescription>{t.apps.intro}</CardDescription>
            </CardHeader>
          </Card>
          {catalog.error ? (
            <QueryError error={catalog.error} />
          ) : !catalog.data ? (
            <Skeleton className="h-40 rounded-xl" />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              {catalog.data.map((a) => (
                <AppCard key={a.id} app={a} onInstall={() => setSelected(a.id)} />
              ))}
            </div>
          )}
          {jobs.data && jobs.data.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t.apps.recent}</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm" data-testid="recent-installs">
                  {jobs.data.map((j) => (
                    <li key={j.id} className="flex flex-wrap items-center justify-between gap-2">
                      <button type="button" className="text-left hover:underline" onClick={() => setJobId(j.id)}>
                        {t.apps.recentRow(j.appName, t.apps.statuses[j.status] ?? j.status)}
                      </button>
                      <span className="text-xs text-muted-foreground">{j.startedAt.toLocaleString()}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function AppCard({ app, onInstall }: { app: AppSummary; onInstall: () => void }) {
  const t = useT();
  const description = t.apps.catalog[app.id]?.description ?? app.description;
  return (
    <Card data-testid="app-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PackagePlus className="size-4 text-muted-foreground" /> {app.name}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline">{app.requiresDatabase ? t.apps.withDatabase : t.apps.noDatabase}</Badge>
          <Badge variant="outline">{t.apps.download(app.downloadMb)}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm" onClick={onInstall} disabled={!app.compatible}>
            {t.apps.install}
          </Button>
          {!app.compatible && <span className="text-xs text-muted-foreground">{t.apps.needsPhp}</span>}
          <a className="ml-auto text-xs text-muted-foreground hover:underline" href={app.homepage} target="_blank" rel="noreferrer">
            {new URL(app.homepage).hostname}
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

function InstallForm({ uuid, app, onCancel, onStarted }: { uuid: string; app: AppSummary; onCancel: () => void; onStarted: (id: number) => void }) {
  const t = useT();
  const check = trpc.apps.check.useQuery({ uuid, appId: app.id });
  const [replace, setReplace] = useState(false);
  const [withAdmin, setWithAdmin] = useState(app.supportsAdmin);
  const [username, setUsername] = useState("admin");
  const [email, setEmail] = useState("");
  const [touched, setTouched] = useState(false);
  const install = trpc.apps.install.useMutation({ onSuccess: (j) => onStarted(j.id) });
  const needsConfirm = check.data ? !check.data.publicEmpty : false;
  const userErr = withAdmin && !USER_RE.test(username) ? t.apps.adminUserError : null;
  const emailErr = withAdmin && !EMAIL_RE.test(email) ? t.apps.adminEmailError : null;
  const blocked = !check.data || (needsConfirm && !replace) || !!userErr || !!emailErr;
  return (
    <Card data-testid="install-form">
      <CardHeader>
        <CardTitle className="text-base">{t.apps.formTitle(app.name)}</CardTitle>
        <CardDescription>{t.apps.catalog[app.id]?.description ?? app.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (blocked) return;
            install.mutate({ uuid, appId: app.id, replaceExisting: replace, admin: withAdmin ? { username, email } : null });
          }}
        >
          {check.error ? (
            <QueryError error={check.error} />
          ) : !check.data ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> {t.apps.checking}
            </p>
          ) : (
            needsConfirm && (
              <Alert variant="warning">
                <AlertTriangle />
                <div className="space-y-2">
                  <AlertDescription>{t.apps.replaceWarn(check.data.entries)}</AlertDescription>
                  <Label className="flex items-center gap-2 font-medium">
                    <Checkbox checked={replace} onChange={(e) => setReplace(e.target.checked)} /> {t.apps.replaceConfirm}
                  </Label>
                </div>
              </Alert>
            )
          )}
          {app.supportsAdmin && (
            <div className="space-y-3">
              <Label className="flex items-center gap-2">
                <Checkbox checked={withAdmin} onChange={(e) => setWithAdmin(e.target.checked)} /> {t.apps.adminOption}
              </Label>
              <p className="text-xs text-muted-foreground">{withAdmin ? t.apps.adminHint : t.apps.adminAfter}</p>
              {withAdmin && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label htmlFor="app-admin-user">{t.apps.adminUser}</Label>
                    <Input id="app-admin-user" value={username} onChange={(e) => setUsername(e.target.value)} aria-invalid={(touched && !!userErr) || undefined} autoComplete="off" />
                    {touched && userErr && <p className="text-xs text-destructive">{userErr}</p>}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="app-admin-email">{t.apps.adminEmail}</Label>
                    <Input id="app-admin-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={(touched && !!emailErr) || undefined} autoComplete="off" />
                    {touched && emailErr && <p className="text-xs text-destructive">{emailErr}</p>}
                  </div>
                </div>
              )}
            </div>
          )}
          {install.error && <p className="text-sm text-destructive">{errorText(install.error)}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={install.isPending || (!!check.data && needsConfirm && !replace)}>
              {install.isPending && <Spinner />} {t.apps.start(app.name)}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t.common.cancel}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function StepIcon({ status }: { status: string }) {
  if (status === "done") return <Check className="size-4 text-success" />;
  if (status === "running") return <Loader2 className="size-4 animate-spin text-primary" />;
  if (status === "failed") return <X className="size-4 text-destructive" />;
  return <CircleDashed className="size-4 text-muted-foreground" />;
}

function JobView({ uuid, jobId, onClose }: { uuid: string; jobId: number; onClose: () => void }) {
  void uuid;
  const t = useT();
  const job = trpc.apps.job.useQuery({ id: jobId }, { refetchInterval: (q) => (q.state.data?.status === "running" || !q.state.data ? POLL_MS : false), refetchOnWindowFocus: false });
  // The admin password is delivered once; keep it here so a refetch cannot lose it.
  const password = useRef<string | null>(null);
  if (job.data?.result?.adminPassword) password.current = job.data.result.adminPassword;
  if (job.error) return <QueryError error={job.error} />;
  if (!job.data) return <Skeleton className="h-48 rounded-xl" />;
  const j: AppJob = job.data;
  const done = j.steps.filter((s) => s.status === "done").length;
  return (
    <Card data-testid="job-view">
      <CardHeader>
        <CardTitle className="text-base">{t.apps.formTitle(j.appName)}</CardTitle>
        <CardDescription>{j.status === "succeeded" ? t.apps.done(j.appName, j.result?.version ?? "") : j.status === "failed" ? t.apps.failed : t.apps.progress}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={(done / Math.max(1, j.steps.length)) * 100} label={t.apps.progress} />
        <ol className="space-y-1.5 text-sm" data-testid="job-steps">
          {j.steps.map((s) => (
            <li key={s.key} className="flex items-center gap-2" data-status={s.status}>
              <StepIcon status={s.status} />
              <span className={s.status === "pending" ? "text-muted-foreground" : undefined}>{t.apps.steps[s.key] ?? s.key}</span>
              <span className="sr-only">{t.apps.stepStatus[s.status]}</span>
            </li>
          ))}
        </ol>
        {j.status === "failed" && (
          <Alert variant="destructive" data-testid="job-error">
            <AlertTriangle />
            <div>
              <AlertTitle>{t.apps.failed}</AlertTitle>
              <AlertDescription>{(j.errorCode && t.apps.errors[j.errorCode]) || j.error}</AlertDescription>
            </div>
          </Alert>
        )}
        {j.status === "succeeded" && j.result && <JobResult result={j.result} password={password.current} />}
        {j.status !== "running" && (
          <Button variant="outline" onClick={onClose}>
            {t.apps.another}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <code className="block truncate font-mono text-sm" data-secret={secret || undefined}>
          {value}
        </code>
      </div>
      <CopyButton value={value} label={useT().common.copyX(label)} />
    </div>
  );
}

function JobResult({ result, password }: { result: NonNullable<AppJob["result"]>; password: string | null }) {
  const t = useT();
  return (
    <div className="space-y-3" data-testid="job-result">
      <h3 className="text-sm font-medium">{t.apps.result}</h3>
      <div className="grid gap-2 sm:grid-cols-2">
        {result.adminUrl && (
          <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 sm:col-span-2">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">{t.apps.adminUrl}</div>
              <a className="block truncate font-mono text-sm hover:underline" href={result.adminUrl} target="_blank" rel="noreferrer" data-testid="admin-url">
                {result.adminUrl}
              </a>
            </div>
            <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
          </div>
        )}
        {result.adminUsername && <Field label={t.apps.username} value={result.adminUsername} />}
        {password && <Field label={t.apps.password} value={password} secret />}
        {result.databaseName && <Field label={t.apps.database} value={result.databaseName} />}
        <Field label={t.apps.version} value={result.version} />
      </div>
      {password ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertDescription>{t.apps.passwordOnce}</AlertDescription>
        </Alert>
      ) : (
        result.adminUsername && <p className="text-xs text-muted-foreground">{t.apps.passwordGone}</p>
      )}
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground" data-testid="job-notes">
        {result.notes.map((n) => (
          <li key={n}>{t.apps.notes[n] ?? n}</li>
        ))}
      </ul>
    </div>
  );
}
