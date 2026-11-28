"use client";
/** Admin → Node: achter Nginx Proxy Manager (NPM bezit 80/443 en SSL; de daemon beheert daar de proxy hosts). */
import { AlertTriangle, PlugZap, Shield } from "lucide-react";
import { useState } from "react";
import type { Node, NodeNpmStatus, NpmSslMode } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { useT } from "@/app/_lib/i18n";
import { AdminError, Field } from "./nodes";

type Form = { url: string; email: string; password: string; forwardHost: string; forwardPort: string; ssl: NpmSslMode; cloudflareToken: string; forceSsl: boolean };

const fromStatus = (s: NodeNpmStatus): Form => ({
  url: s.settings?.url ?? "http://127.0.0.1:81",
  email: s.settings?.email ?? "",
  password: "",
  forwardHost: s.settings?.forwardHost ?? "",
  forwardPort: s.settings?.forwardPort ? String(s.settings.forwardPort) : "",
  ssl: s.settings?.ssl ?? "http",
  cloudflareToken: "",
  forceSsl: s.settings?.forceSsl ?? true,
});

const stateVariant = (state: string) => (state === "ok" ? "success" : state === "unconfigured" ? "secondary" : "destructive");

export function NodeNpm({ node }: { node: Node }) {
  const t = useT();
  const m = t.admin.nodes.npm;
  const utils = trpc.useUtils();
  const st = trpc.admin.nodes.npmStatus.useQuery({ id: node.id }, { refetchInterval: 15_000 });
  const [form, setForm] = useState<Form | null>(null);
  const done = () => {
    setForm(null);
    void utils.admin.nodes.npmStatus.invalidate({ id: node.id });
    void utils.admin.nodes.get.invalidate({ id: node.id });
    void utils.admin.nodes.list.invalidate();
  };
  const save = trpc.admin.nodes.setNpm.useMutation({ onSuccess: done });
  const test = trpc.admin.nodes.testNpm.useMutation();
  if (st.error) return <AdminError error={st.error} />;
  if (!st.data) return <Skeleton className="h-32 rounded-xl" />;
  const s = st.data;
  const enabled = s.settings !== null;
  const relayed = node.httpRelayNodeId !== null;
  const f = form ?? fromStatus(s);
  const editing = form !== null;
  const set = (patch: Partial<Form>) => setForm({ ...f, ...patch });
  const r = s.report;
  const needsMode = enabled && r !== null && r.httpMode !== null && r.httpMode !== "npm";

  const submit = () =>
    save.mutate({
      id: node.id,
      settings: {
        url: f.url.trim(),
        email: f.email.trim(),
        ...(f.password ? { password: f.password } : {}),
        forwardHost: f.forwardHost.trim() || null,
        forwardPort: f.forwardPort ? Number(f.forwardPort) : null,
        ssl: f.ssl,
        ...(f.cloudflareToken ? { cloudflareToken: f.cloudflareToken } : {}),
        forceSsl: f.forceSsl,
      },
    });

  return (
    <Card data-testid="node-npm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Shield className="size-4" /> {m.title}
          {enabled && <Badge variant="info">{m.badge}</Badge>}
          {enabled && r && (
            <Badge variant={stateVariant(r.state)} data-testid="npm-state">
              {m.state[r.state] ?? r.state}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>{m.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {relayed ? (
          <p className="text-muted-foreground">{m.relayNote}</p>
        ) : !enabled && !editing ? (
          <Button variant="outline" onClick={() => setForm(fromStatus(s))} data-testid="npm-enable">
            {m.enable}
          </Button>
        ) : (
          <div className="space-y-3" data-testid="npm-form">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={`npm-url-${node.id}`} label={m.url} hint={m.urlHint}>
                <Input id={`npm-url-${node.id}`} value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="http://127.0.0.1:81" />
              </Field>
              <Field id={`npm-email-${node.id}`} label={m.email} hint={m.emailHint}>
                <Input id={`npm-email-${node.id}`} type="email" autoComplete="off" value={f.email} onChange={(e) => set({ email: e.target.value })} />
              </Field>
              <Field id={`npm-password-${node.id}`} label={m.password} hint={s.settings?.hasPassword ? m.passwordKeep : undefined}>
                <Input id={`npm-password-${node.id}`} type="password" autoComplete="new-password" value={f.password} onChange={(e) => set({ password: e.target.value })} placeholder={s.settings?.hasPassword ? "••••••••" : ""} />
              </Field>
              <Field id={`npm-ssl-${node.id}`} label={m.ssl}>
                <Select id={`npm-ssl-${node.id}`} value={f.ssl} onChange={(e) => set({ ssl: e.target.value as NpmSslMode })}>
                  <option value="http">{m.sslHttp}</option>
                  <option value="cloudflare">{m.sslCloudflare}</option>
                </Select>
              </Field>
              {f.ssl === "cloudflare" && (
                <Field id={`npm-cf-${node.id}`} label={m.cloudflareToken} hint={s.settings?.hasCloudflareToken ? m.passwordKeep : m.cloudflareHint}>
                  <Input id={`npm-cf-${node.id}`} type="password" autoComplete="off" value={f.cloudflareToken} onChange={(e) => set({ cloudflareToken: e.target.value })} placeholder={s.settings?.hasCloudflareToken ? "••••••••" : ""} />
                </Field>
              )}
              <Field id={`npm-fwd-${node.id}`} label={m.forward} hint={m.forwardHint}>
                <div className="flex gap-2">
                  <Input id={`npm-fwd-${node.id}`} value={f.forwardHost} onChange={(e) => set({ forwardHost: e.target.value })} placeholder="172.17.0.1" />
                  <Input aria-label={m.forwardPort} className="w-28" inputMode="numeric" value={f.forwardPort} onChange={(e) => set({ forwardPort: e.target.value.replace(/\D/g, "") })} placeholder="8081" />
                </div>
              </Field>
            </div>
            <label className="flex items-center gap-2">
              <Checkbox checked={f.forceSsl} onChange={(e) => set({ forceSsl: e.target.checked })} /> {m.forceSsl}
            </label>
            <p className="text-xs text-muted-foreground">{m.alwaysOn}</p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={submit} disabled={save.isPending || !f.url || !f.email} data-testid="npm-save">
                {save.isPending && <Spinner />} {m.save}
              </Button>
              <Button variant="outline" onClick={() => test.mutate({ id: node.id, url: f.url.trim(), email: f.email.trim(), ...(f.password ? { password: f.password } : {}) })} disabled={test.isPending || !f.url || !f.email} data-testid="npm-test">
                {test.isPending ? <Spinner /> : <PlugZap />} {m.test}
              </Button>
              {editing && (
                <Button variant="ghost" onClick={() => setForm(null)}>
                  {t.common.cancel}
                </Button>
              )}
              {enabled && (
                <Button variant="ghost" className="text-destructive" onClick={() => save.mutate({ id: node.id, settings: null })} disabled={save.isPending} data-testid="npm-disable">
                  {m.disable}
                </Button>
              )}
            </div>
            {test.data && (
              <p className={test.data.state === "ok" ? "text-xs text-success" : "text-xs text-destructive"} role="status" data-testid="npm-test-result">
                {test.data.state === "ok" ? m.testOk(test.data.version ?? "?", test.data.proxyHosts, test.data.managedHosts) : `${m.state[test.data.state] ?? test.data.state}${test.data.error ? `: ${test.data.error}` : ""}`}
              </p>
            )}
            {(save.error || test.error) && <AdminError error={save.error ?? test.error} />}
            {save.isSuccess && (
              <p className="text-xs text-success" role="status">
                {m.saved}
              </p>
            )}
          </div>
        )}

        {enabled && r && (
          <div className="space-y-2" data-testid="npm-report">
            <p className="text-xs text-muted-foreground">
              {m.reported(r.version ?? "?", r.proxyHosts, r.managedHosts)}
              {r.error && <span className="text-destructive"> · {r.error}</span>}
            </p>
            {r.conflicts.length > 0 && (
              <Alert variant="warning" data-testid="npm-conflicts">
                <AlertTriangle />
                <div>
                  <AlertTitle>{m.conflictsTitle}</AlertTitle>
                  <AlertDescription>
                    {m.conflictsText} <code className="font-mono">{r.conflicts.join(", ")}</code>
                  </AlertDescription>
                </div>
              </Alert>
            )}
            {r.hosts.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {r.hosts.map((x) => (
                  <li key={x.host} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
                    <code className="font-mono text-xs">{x.host}</code>
                    <span className="flex items-center gap-1.5">
                      {x.error && x.ssl !== "active" && <span className="max-w-xs truncate text-xs text-muted-foreground" title={x.error}>{x.error}</span>}
                      <Badge variant={x.ssl === "active" ? "success" : x.ssl === "failed" || x.ssl === "dns_wrong" ? "destructive" : "secondary"}>{t.dns.ssl[x.ssl].label}</Badge>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {enabled && !r && <p className="text-xs text-muted-foreground">{m.noReport}</p>}

        {s.modeCommand && (needsMode || editing || save.isSuccess || !r) && (
          <div className="space-y-1" data-testid="npm-mode-command">
            <p className="text-xs text-muted-foreground">{enabled ? m.modeNpm : m.modeDirect}</p>
            <div className="flex items-start gap-1 rounded-md border border-border bg-background/60 px-3 py-2">
              <code className="flex-1 break-all font-mono text-xs">{s.modeCommand}</code>
              <CopyButton value={s.modeCommand} label={t.common.copyX(m.title)} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
