"use client";
import { AlertTriangle, Ban, Check, CircleDashed, GitBranch, KeyRound, Loader2, Rocket, ShieldCheck, Webhook, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Deploy, DeployAuthType, DeployBuildImage, DeployConfig, DeployStatus } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Badge, type BadgeVariant } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatDate, formatDuration } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";

export const DEPLOY_POLL_MS = 1500;
const BUILD_IMAGES: DeployBuildImage[] = ["site", "node:24-alpine", "node:22-alpine", "composer:2"];
const STATUS_VARIANT: Record<DeployStatus, BadgeVariant> = { running: "info", succeeded: "success", failed: "destructive", cancelled: "secondary" };

/** SSH-vorm van een repo-URL (git@host:pad of ssh://). */
export const looksSsh = (url: string) => /^ssh:\/\//.test(url) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(url);

export function DeployManager({ uuid }: { uuid: string }) {
  const t = useT();
  const config = trpc.deploy.config.useQuery({ uuid });
  const list = trpc.deploy.list.useQuery({ uuid, limit: 20 }, { refetchInterval: (q) => (q.state.data?.items.some((d) => d.status === "running") ? DEPLOY_POLL_MS * 2 : false) });
  const [editing, setEditing] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const running = list.data?.items.find((d) => d.status === "running") ?? null;

  if (config.error) return <QueryError error={config.error} />;
  if (!config.data) return <Skeleton className="h-48 rounded-xl" />;
  const c = config.data;
  const showForm = c.canManage && (editing || !c.configured);
  return (
    <div className="max-w-4xl space-y-6" data-testid="deploy-manager">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitBranch className="size-4 text-muted-foreground" /> {t.deploy.title}
          </CardTitle>
          <CardDescription>{t.deploy.intro}</CardDescription>
        </CardHeader>
        {c.configured && !showForm && (
          <CardContent>
            <Summary uuid={uuid} c={c} last={list.data?.items[0] ?? null} running={running} onEdit={() => setEditing(true)} onStarted={(id) => setOpenId(id)} />
          </CardContent>
        )}
        {!c.configured && !c.canManage && (
          <CardContent>
            <p className="text-sm text-muted-foreground" data-testid="deploy-not-configured">
              {t.deploy.notConfiguredReadOnly}
            </p>
          </CardContent>
        )}
      </Card>
      {showForm && <ConfigForm uuid={uuid} c={c} onDone={() => setEditing(false)} onCancel={c.configured ? () => setEditing(false) : undefined} />}
      {running && <DeployView key={running.id} id={running.id} canManage={c.canManage} live onFinished={() => void list.refetch()} />}
      {c.configured && c.canManage && c.authType === "ssh" && <SshCard uuid={uuid} c={c} />}
      {c.configured && c.canManage && c.webhookUrl && <WebhookCard uuid={uuid} c={c} />}
      {(c.configured || (list.data?.items.length ?? 0) > 0) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t.deploy.history}</CardTitle>
          </CardHeader>
          <CardContent>
            {list.error ? (
              <QueryError error={list.error} />
            ) : !list.data ? (
              <Skeleton className="h-24" />
            ) : list.data.items.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t.deploy.noHistory}</p>
            ) : (
              <ul className="divide-y divide-border" data-testid="deploy-history">
                {list.data.items.map((d) => (
                  <li key={d.id} className="py-2">
                    <HistoryRow d={d} open={openId === d.id} onToggle={() => setOpenId(openId === d.id ? null : d.id)} />
                    {openId === d.id && d.status !== "running" && <DeployView id={d.id} canManage={c.canManage} />}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: DeployStatus }) {
  const t = useT();
  const Icon = status === "running" ? Loader2 : status === "succeeded" ? Check : status === "failed" ? X : Ban;
  return (
    <Badge variant={STATUS_VARIANT[status]} data-status={status}>
      <Icon className={cn(status === "running" && "animate-spin")} /> {t.deploy.statuses[status] ?? status}
    </Badge>
  );
}

function Summary({ uuid, c, last, running, onEdit, onStarted }: { uuid: string; c: DeployConfig; last: Deploy | null; running: Deploy | null; onEdit: () => void; onStarted: (id: number) => void }) {
  const t = useT();
  const utils = trpc.useUtils();
  const start = trpc.deploy.start.useMutation({
    onSuccess: (d) => {
      onStarted(d.id);
      void utils.deploy.list.invalidate({ uuid });
    },
  });
  return (
    <div className="space-y-3" data-testid="deploy-summary">
      <div className="min-w-0 space-y-1 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <code className="truncate font-mono" title={c.repoUrl ?? ""}>
            {t.deploy.repoLine(c.repoUrl ?? "", c.branch)}
          </code>
        </div>
        <div className="text-muted-foreground">{t.deploy.targetLine(c.targetDir)}</div>
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
          <span>{t.deploy.lastDeploy}:</span>
          {last ? (
            <>
              <StatusBadge status={last.status} /> <span>{formatDate(last.startedAt)}</span>
            </>
          ) : (
            <span>{t.deploy.never}</span>
          )}
        </div>
      </div>
      {start.error && <p className="text-sm text-destructive">{errorText(start.error)}</p>}
      {c.canManage && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => start.mutate({ uuid })} disabled={start.isPending || !!running} data-testid="deploy-now">
            {start.isPending || running ? <Spinner /> : <Rocket />} {running ? t.deploy.deploying : t.deploy.deployNow}
          </Button>
          <Button variant="outline" onClick={onEdit}>
            {t.deploy.editSettings}
          </Button>
        </div>
      )}
    </div>
  );
}

interface FormState {
  repoUrl: string;
  branch: string;
  authType: DeployAuthType;
  token: string;
  tokenUsername: string;
  targetDir: string;
  sourceDir: string;
  buildCommand: string;
  buildImage: DeployBuildImage;
  sharedPaths: string;
  restartAfter: boolean;
  autoDeploy: boolean;
}

const fromConfig = (c: DeployConfig): FormState => ({
  repoUrl: c.repoUrl ?? "",
  branch: c.branch,
  authType: c.authType,
  token: "",
  tokenUsername: c.tokenUsername ?? "",
  targetDir: c.targetDir,
  sourceDir: c.sourceDir,
  buildCommand: c.buildCommand ?? "",
  buildImage: c.buildImage,
  sharedPaths: c.sharedPaths.join("\n"),
  restartAfter: c.restartAfter,
  autoDeploy: c.autoDeploy,
});

function ConfigForm({ uuid, c, onDone, onCancel }: { uuid: string; c: DeployConfig; onDone: () => void; onCancel?: () => void }) {
  const t = useT();
  const utils = trpc.useUtils();
  const [f, setF] = useState<FormState>(() => fromConfig(c));
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((x) => ({ ...x, [k]: v }));
  const configure = trpc.deploy.configure.useMutation({
    onSuccess: (data) => {
      utils.deploy.config.setData({ uuid }, data);
      onDone();
    },
  });
  const disconnect = trpc.deploy.disconnect.useMutation({ onSuccess: () => void utils.deploy.config.invalidate({ uuid }) });
  const ssh = looksSsh(f.repoUrl.trim());
  // SSH-URL → altijd een deploy key; https met "SSH" gekozen → terug naar openbaar.
  useEffect(() => {
    if (ssh && f.authType !== "ssh") set("authType", "ssh");
    if (!ssh && f.authType === "ssh" && f.repoUrl.trim()) set("authType", "none");
  }, [ssh, f.authType, f.repoUrl]);
  const id = (k: string) => `deploy-${k}`;
  return (
    <Card data-testid="deploy-form">
      <CardHeader>
        <CardTitle className="text-base">{c.configured ? t.deploy.settings : t.deploy.connect}</CardTitle>
        {!c.configured && <CardDescription>{t.deploy.notConfigured}</CardDescription>}
      </CardHeader>
      <CardContent>
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            configure.mutate({
              uuid,
              repoUrl: f.repoUrl.trim(),
              branch: f.branch.trim() || "main",
              authType: f.authType,
              ...(f.authType === "token" && f.token.trim() ? { token: f.token.trim() } : {}),
              tokenUsername: f.authType === "token" && f.tokenUsername.trim() ? f.tokenUsername.trim() : null,
              targetDir: f.targetDir.trim() || c.defaultTargetDir,
              sourceDir: f.sourceDir.trim() || "/",
              buildCommand: f.buildCommand.trim() || null,
              buildImage: f.buildImage,
              sharedPaths: f.sharedPaths.split("\n").map((s) => s.trim()).filter(Boolean),
              restartAfter: f.restartAfter,
              autoDeploy: f.autoDeploy,
            });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor={id("repo")}>{t.deploy.repoUrl}</Label>
            <Input id={id("repo")} value={f.repoUrl} onChange={(e) => set("repoUrl", e.target.value)} placeholder="https://github.com/…/site.git" autoComplete="off" spellCheck={false} inputMode="url" required />
            <p className="text-xs text-muted-foreground">{t.deploy.repoUrlHint}</p>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t.deploy.access}</legend>
            {(["none", "token", "ssh"] as const).map((a) => (
              <label key={a} className={cn("flex min-h-11 items-center gap-2 text-sm md:min-h-0", (a === "ssh") !== ssh && f.repoUrl.trim() && "opacity-50")}>
                <input type="radio" name="deploy-auth" value={a} checked={f.authType === a} disabled={!!f.repoUrl.trim() && (a === "ssh") !== ssh} onChange={() => set("authType", a)} />
                {a === "none" ? t.deploy.authNone : a === "token" ? t.deploy.authToken : t.deploy.authSsh}
              </label>
            ))}
          </fieldset>
          {f.authType === "token" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={id("token")}>{t.deploy.token}</Label>
                <Input id={id("token")} type="password" value={f.token} onChange={(e) => set("token", e.target.value)} placeholder={c.tokenSet ? t.deploy.tokenKeep : ""} autoComplete="new-password" />
                <p className="text-xs text-muted-foreground">{t.deploy.tokenHint}</p>
              </div>
              <div className="space-y-1">
                <Label htmlFor={id("user")}>{t.deploy.tokenUsername}</Label>
                <Input id={id("user")} value={f.tokenUsername} onChange={(e) => set("tokenUsername", e.target.value)} placeholder="x-access-token" autoComplete="off" />
                <p className="text-xs text-muted-foreground">{t.deploy.tokenUsernameHint}</p>
              </div>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor={id("branch")}>{t.deploy.branch}</Label>
              <Input id={id("branch")} value={f.branch} onChange={(e) => set("branch", e.target.value)} placeholder="main" autoComplete="off" spellCheck={false} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={id("target")}>{t.deploy.targetDir}</Label>
              <Input id={id("target")} value={f.targetDir} onChange={(e) => set("targetDir", e.target.value)} placeholder={c.defaultTargetDir} autoComplete="off" spellCheck={false} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={id("source")}>{t.deploy.sourceDir}</Label>
              <Input id={id("source")} value={f.sourceDir} onChange={(e) => set("sourceDir", e.target.value)} placeholder="/" autoComplete="off" spellCheck={false} />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {t.deploy.targetDirHint(c.defaultTargetDir)} {t.deploy.sourceDirHint}
          </p>
          <div className="grid gap-3 sm:grid-cols-[1fr_14rem]">
            <div className="space-y-1">
              <Label htmlFor={id("build")}>{t.deploy.buildCommand}</Label>
              <Input id={id("build")} className="font-mono" value={f.buildCommand} onChange={(e) => set("buildCommand", e.target.value)} placeholder="npm ci && npm run build" autoComplete="off" spellCheck={false} />
            </div>
            <div className="space-y-1">
              <Label htmlFor={id("image")}>{t.deploy.buildImage}</Label>
              <Select id={id("image")} value={f.buildImage} onChange={(e) => set("buildImage", e.target.value as DeployBuildImage)}>
                {BUILD_IMAGES.map((i) => (
                  <option key={i} value={i}>
                    {t.deploy.buildImages[i] ?? i}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t.deploy.buildCommandHint}</p>
          <div className="space-y-1">
            <Label htmlFor={id("shared")}>{t.deploy.sharedPaths}</Label>
            <textarea id={id("shared")} className="min-h-20 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm" value={f.sharedPaths} onChange={(e) => set("sharedPaths", e.target.value)} placeholder={"/.env\n/uploads"} spellCheck={false} />
            <p className="text-xs text-muted-foreground">{t.deploy.sharedPathsHint}</p>
          </div>
          <Label className="flex min-h-11 items-center gap-2 md:min-h-0">
            <Checkbox checked={f.autoDeploy} onChange={(e) => set("autoDeploy", e.target.checked)} /> {t.deploy.autoDeploy}
          </Label>
          <Label className="flex min-h-11 items-center gap-2 md:min-h-0">
            <Checkbox checked={f.restartAfter} onChange={(e) => set("restartAfter", e.target.checked)} /> {t.deploy.restartAfter}
          </Label>
          {configure.error && (
            <p className="text-sm text-destructive" role="alert">
              {errorText(configure.error)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={configure.isPending || !f.repoUrl.trim()}>
              {configure.isPending && <Spinner />} {t.deploy.save}
            </Button>
            {onCancel && (
              <Button type="button" variant="ghost" onClick={onCancel}>
                {t.common.cancel}
              </Button>
            )}
            {c.configured && (
              <Button type="button" variant="ghost" className="text-destructive sm:ml-auto" onClick={() => setConfirmDisconnect(true)}>
                {t.deploy.disconnect}
              </Button>
            )}
          </div>
          {confirmDisconnect && (
            <Alert variant="warning" data-testid="deploy-disconnect-confirm">
              <AlertTriangle />
              <div className="space-y-2">
                <AlertDescription>{t.deploy.disconnectConfirm}</AlertDescription>
                <div className="flex gap-2">
                  <Button type="button" size="sm" variant="destructive" disabled={disconnect.isPending} onClick={() => disconnect.mutate({ uuid })}>
                    {t.deploy.disconnect}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDisconnect(false)}>
                    {t.common.cancel}
                  </Button>
                </div>
              </div>
            </Alert>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

function Secret({ label, value, testId }: { label: string; value: string; testId?: string }) {
  const t = useT();
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      <div className="min-w-0">
        <div className="text-xs text-muted-foreground">{label}</div>
        <code className="block break-all font-mono text-xs sm:text-sm" data-testid={testId}>
          {value}
        </code>
      </div>
      <CopyButton value={value} label={t.common.copyX(label)} />
    </div>
  );
}

function WebhookCard({ uuid, c }: { uuid: string; c: DeployConfig }) {
  const t = useT();
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState(false);
  const rotate = trpc.deploy.rotateWebhookSecret.useMutation({
    onSuccess: (data) => {
      utils.deploy.config.setData({ uuid }, data);
      setConfirm(false);
    },
  });
  return (
    <Card data-testid="deploy-webhook">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Webhook className="size-4 text-muted-foreground" /> {t.deploy.webhook}
        </CardTitle>
        <CardDescription>{c.autoDeploy ? t.deploy.webhookIntro : t.deploy.webhookOff}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Secret label={t.deploy.webhookUrl} value={c.webhookUrl!} testId="webhook-url" />
        <Secret label={t.deploy.webhookSecret} value={c.webhookSecret!} testId="webhook-secret" />
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>{t.deploy.webhookGithub}</li>
          <li>{t.deploy.webhookGitlab}</li>
          <li>{t.deploy.webhookGeneric}</li>
        </ul>
        {rotate.error && <p className="text-sm text-destructive">{errorText(rotate.error)}</p>}
        {confirm ? (
          <Alert variant="warning">
            <AlertTriangle />
            <div className="space-y-2">
              <AlertDescription>{t.deploy.webhookRotateConfirm}</AlertDescription>
              <div className="flex gap-2">
                <Button size="sm" disabled={rotate.isPending} onClick={() => rotate.mutate({ uuid })}>
                  {t.deploy.webhookRotate}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                  {t.common.cancel}
                </Button>
              </div>
            </div>
          </Alert>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
            {t.deploy.webhookRotate}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function SshCard({ uuid, c }: { uuid: string; c: DeployConfig }) {
  const t = useT();
  const utils = trpc.useUtils();
  const [confirm, setConfirm] = useState(false);
  const setData = (data: DeployConfig) => utils.deploy.config.setData({ uuid }, data);
  const gen = trpc.deploy.generateKey.useMutation({
    onSuccess: (d) => {
      setData(d);
      setConfirm(false);
    },
  });
  const scan = trpc.deploy.scanHostKey.useMutation();
  const trust = trpc.deploy.trustHostKey.useMutation({ onSuccess: setData });
  const repoUrl = c.repoUrl ?? "";
  const host = scan.data?.host ?? c.sshHost?.host ?? (/@([^:/]+)/.exec(repoUrl)?.[1] ?? "");
  return (
    <Card data-testid="deploy-ssh">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-muted-foreground" /> {t.deploy.sshKey}
        </CardTitle>
        <CardDescription>{t.deploy.sshKeyIntro}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {c.sshPublicKey ? <Secret label={t.deploy.sshKey} value={c.sshPublicKey} testId="deploy-public-key" /> : <p className="text-sm text-muted-foreground">{t.deploy.sshKeyMissing}</p>}
        {gen.error && <p className="text-sm text-destructive">{errorText(gen.error)}</p>}
        {confirm || !c.sshPublicKey ? (
          <div className="space-y-2">
            {c.sshPublicKey && <p className="text-sm text-warning">{t.deploy.regenerateConfirm}</p>}
            <div className="flex gap-2">
              <Button size="sm" variant={c.sshPublicKey ? "destructive" : "default"} disabled={gen.isPending} onClick={() => gen.mutate({ uuid })}>
                {gen.isPending && <Spinner />} {c.sshPublicKey ? t.deploy.regenerateKey : t.deploy.generateKey}
              </Button>
              {c.sshPublicKey && (
                <Button size="sm" variant="ghost" onClick={() => setConfirm(false)}>
                  {t.common.cancel}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <Button size="sm" variant="outline" onClick={() => setConfirm(true)}>
            {t.deploy.regenerateKey}
          </Button>
        )}
        <div className="space-y-2 border-t border-border pt-4" data-testid="deploy-hostkey">
          <h4 className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4 text-muted-foreground" /> {t.deploy.hostKey}
          </h4>
          {c.sshHost ? (
            <>
              <p className="text-sm text-muted-foreground">{c.sshHost.trust === "builtin" ? t.deploy.hostKeyBuiltin(c.sshHost.host) : t.deploy.hostKeyConfirmed(c.sshHost.host)}</p>
              <ul className="space-y-1">
                {c.sshHost.keys.map((k) => (
                  <li key={k.fingerprint} className="break-all font-mono text-xs">
                    {k.type} {k.fingerprint}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <Alert variant="warning">
                <AlertTriangle />
                <AlertDescription>{t.deploy.hostKeyUnknown(host)}</AlertDescription>
              </Alert>
              {scan.data ? (
                <div className="space-y-2">
                  <div className="text-xs text-muted-foreground">{t.deploy.hostKeyFingerprints}</div>
                  <ul className="space-y-1" data-testid="scanned-keys">
                    {scan.data.keys.map((k) => (
                      <li key={k.fingerprint} className="break-all font-mono text-xs">
                        {k.type} {k.fingerprint}
                      </li>
                    ))}
                  </ul>
                  <Button size="sm" disabled={trust.isPending} onClick={() => trust.mutate({ uuid, repoUrl, fingerprints: scan.data!.keys.map((k) => k.fingerprint) })}>
                    {trust.isPending && <Spinner />} {t.deploy.hostKeyTrust}
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="outline" disabled={scan.isPending} onClick={() => scan.mutate({ uuid, repoUrl })}>
                  {scan.isPending && <Spinner />} {t.deploy.hostKeyScan}
                </Button>
              )}
              {(scan.error || trust.error) && <p className="text-sm text-destructive">{errorText(scan.error ?? trust.error)}</p>}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function HistoryRow({ d, open, onToggle }: { d: Deploy; open: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button type="button" className="flex w-full flex-col gap-1 rounded-md px-1 py-1 text-left hover:bg-muted/40 sm:flex-row sm:items-center sm:gap-3" onClick={onToggle} aria-expanded={open} data-testid="deploy-row">
      <span className="flex items-center gap-2">
        <StatusBadge status={d.status} />
        <code className="font-mono text-xs text-muted-foreground">{d.commitSha ? d.commitSha.slice(0, 8) : "········"}</code>
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">{d.commitMessage ?? t.deploy.noCommit}</span>
      <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        {d.commitAuthor && <span>{d.commitAuthor}</span>}
        <span>{formatDate(d.startedAt)}</span>
        {d.durationMs !== null && <span>{t.deploy.duration(formatDuration(d.durationMs))}</span>}
        <span>{d.triggeredBy ? `${t.deploy.triggers[d.trigger]} · ${t.deploy.byWho(d.triggeredBy)}` : t.deploy.triggers[d.trigger]}</span>
      </span>
    </button>
  );
}

/** Eén deploy met log; `live` = pollen zolang hij loopt. */
function DeployView({ id, canManage, live, onFinished }: { id: number; canManage: boolean; live?: boolean; onFinished?: () => void }) {
  const t = useT();
  const q = trpc.deploy.get.useQuery({ id }, { refetchInterval: (s) => (live && (!s.state.data || s.state.data.status === "running") ? DEPLOY_POLL_MS : false), refetchOnWindowFocus: false });
  const cancel = trpc.deploy.cancel.useMutation({ onSuccess: () => void q.refetch() });
  const logRef = useRef<HTMLPreElement>(null);
  const status = q.data?.status;
  useEffect(() => {
    if (live && status && status !== "running") onFinished?.();
  }, [live, status, onFinished]);
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [q.data?.log.length]);
  if (q.error) return <QueryError error={q.error} />;
  if (!q.data) return <Skeleton className="h-32 rounded-xl" />;
  const d = q.data;
  const body = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge status={d.status} />
        {d.phase && (
          <span className="inline-flex items-center gap-1 text-muted-foreground" data-testid="deploy-phase">
            <CircleDashed className="size-3.5 animate-spin" /> {t.deploy.phases[d.phase] ?? d.phase}
          </span>
        )}
        {d.commitSha && (
          <span className="min-w-0 truncate text-muted-foreground">
            <code className="font-mono">{d.commitSha.slice(0, 8)}</code> {d.commitMessage}
          </span>
        )}
      </div>
      {d.status === "failed" && d.error && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertDescription>
            <span className="break-words">{d.error}</span> <span className="block text-xs opacity-80">{t.deploy.keptPrevious}</span>
          </AlertDescription>
        </Alert>
      )}
      <pre ref={logRef} className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-black/80 p-3 font-mono text-xs text-zinc-100" data-testid="deploy-log" aria-live={d.status === "running" ? "polite" : undefined}>
        {d.log.length ? d.log.join("\n") : t.deploy.logEmpty}
      </pre>
      {cancel.error && <p className="text-sm text-destructive">{errorText(cancel.error)}</p>}
      {canManage && d.status === "running" && (
        <Button variant="outline" size="sm" disabled={!d.cancellable || cancel.isPending} onClick={() => cancel.mutate({ id })} data-testid="deploy-cancel">
          {cancel.isPending ? <Spinner /> : <Ban />} {cancel.isPending ? t.deploy.cancelling : t.deploy.cancel}
        </Button>
      )}
    </div>
  );
  if (!live) return <div className="pt-2">{body}</div>;
  return (
    <Card data-testid="deploy-live">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Rocket className="size-4 text-muted-foreground" /> {t.deploy.deploying} <Badge variant="info">{t.deploy.live}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}
