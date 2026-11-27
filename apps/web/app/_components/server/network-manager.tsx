"use client";
import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import type { NetworkCandidate, NetworkUpdateResult, ServerDetail } from "@panel/api";
import { NetworkName } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

interface Row {
  uuid: string;
  name: string;
  selected: boolean;
  isDefault: boolean;
}

/** Network tab of a proxy server: pick the backends, name them, choose the default, save. */
export function NetworkManager({ server }: { server: ServerDetail }) {
  const t = useT();
  const n = t.network;
  const utils = trpc.useUtils();
  const candidates = trpc.servers.networkCandidates.useQuery({ uuid: server.uuid });
  const [rows, setRows] = useState<Row[] | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [result, setResult] = useState<NetworkUpdateResult | null>(null);
  const save = trpc.servers.updateNetwork.useMutation({
    onSuccess: (r) => {
      setConfirm(false);
      setResult(r);
      void utils.servers.get.invalidate({ uuid: server.uuid });
      void utils.servers.networkCandidates.invalidate({ uuid: server.uuid });
    },
  });

  // Start from the saved network: members first (in try order), then the other candidates.
  useEffect(() => {
    if (!candidates.data || rows) return;
    const members = server.network.members;
    const byUuid = new Map(candidates.data.map((c) => [c.uuid, c]));
    const first: Row[] = members.filter((m) => byUuid.has(m.serverUuid)).map((m) => ({ uuid: m.serverUuid, name: m.name, selected: true, isDefault: m.isDefault }));
    const rest: Row[] = candidates.data.filter((c) => !members.some((m) => m.serverUuid === c.uuid)).map((c) => ({ uuid: c.uuid, name: c.suggestedName, selected: false, isDefault: false }));
    setRows([...first, ...rest]);
  }, [candidates.data, rows, server.network.members]);

  const cand = (uuid: string): NetworkCandidate => candidates.data!.find((c) => c.uuid === uuid)!;
  const patch = (uuid: string, p: Partial<Row>) => setRows((rs) => rs!.map((r) => (r.uuid === uuid ? { ...r, ...p } : r)));
  const selected = (rows ?? []).filter((r) => r.selected);
  const nameErr = (r: Row) => (!NetworkName.safeParse(r.name).success ? n.invalidName : selected.some((o) => o !== r && o.name === r.name) ? n.duplicateName : null);
  const defaultOk = selected.length === 0 || selected.some((r) => r.isDefault);
  const valid = defaultOk && selected.every((r) => !nameErr(r));

  const select = (r: Row, on: boolean) => {
    setResult(null);
    setRows((rs) => {
      const next = rs!.map((x) => (x.uuid === r.uuid ? { ...x, selected: on, isDefault: on ? x.isDefault : false } : x));
      // The first selected server becomes the default when none is chosen yet.
      const sel = next.filter((x) => x.selected);
      if (sel.length && !sel.some((x) => x.isDefault)) sel[0]!.isDefault = true;
      return next;
    });
  };

  const submit = (restart: boolean) =>
    save.mutate({ uuid: server.uuid, restart, members: selected.map((r) => ({ serverUuid: r.uuid, name: r.name, isDefault: r.isDefault })) });

  // Servers that would be restarted: new members and removed members; the proxy itself only reloads.
  const removed = server.network.members.filter((m) => !selected.some((r) => r.uuid === m.serverUuid));
  const added = selected.filter((r) => !server.network.members.some((m) => m.serverUuid === r.uuid));
  const affected = [...added.map((r) => cand(r.uuid).name), ...removed.map((m) => m.serverName)];

  return (
    <div className="max-w-4xl space-y-6" data-testid="network-manager">
      <p className="text-sm text-muted-foreground">{n.intro}</p>

      {server.network.connectAddress && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{n.connectTitle}</CardTitle>
            <CardDescription>{n.connectText}</CardDescription>
          </CardHeader>
          <CardContent className="flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 font-mono text-sm" data-testid="network-connect">{server.network.connectAddress}</code>
            <CopyButton value={server.network.connectAddress} />
          </CardContent>
        </Card>
      )}

      <Alert variant="warning">
        <TriangleAlert />
        <div>
          <AlertTitle>{n.warnTitle}</AlertTitle>
          <AlertDescription>{n.warnText}</AlertDescription>
        </div>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{n.backendsTitle}</CardTitle>
          <CardDescription>{n.defaultHint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {candidates.error ? (
            <QueryError error={candidates.error} />
          ) : !rows || !candidates.data ? (
            <Skeleton className="h-32 rounded-xl" />
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{n.backendsEmpty}</p>
          ) : (
            rows.map((r) => {
              const c = cand(r.uuid);
              const taken = !!c.takenBy;
              const err = r.selected ? nameErr(r) : null;
              return (
                <div key={r.uuid} className="flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border border-border p-3" data-testid="network-row">
                  <label className="flex min-w-48 flex-1 items-center gap-2 text-sm">
                    <Checkbox aria-label={n.use(c.name)} checked={r.selected} disabled={taken || save.isPending} onChange={(e) => select(r, e.target.checked)} />
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted-foreground">{c.templateName}</span>
                    {c.address && <code className="font-mono text-xs text-muted-foreground">{c.address}</code>}
                  </label>
                  {taken ? (
                    <Badge variant="outline">{n.takenBy(c.takenBy!)}</Badge>
                  ) : (
                    r.selected && (
                      <>
                        <div className="space-y-1">
                          <Input aria-label={n.nameLabel(c.name)} aria-invalid={!!err} className="h-8 w-44 font-mono" value={r.name} onChange={(e) => patch(r.uuid, { name: e.target.value.toLowerCase() })} />
                          <p className={err ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{err ?? n.nameHint}</p>
                        </div>
                        <label className="flex items-center gap-2 pt-1.5 text-sm">
                          <input type="radio" name="network-default" className="accent-primary" aria-label={n.defaultFor(c.name)} checked={r.isDefault} onChange={() => setRows((rs) => rs!.map((x) => ({ ...x, isDefault: x.uuid === r.uuid })))} />
                          {n.defaultLabel}
                        </label>
                      </>
                    )
                  )}
                </div>
              );
            })
          )}
          {!defaultOk && <p className="text-sm text-destructive">{n.needDefault}</p>}
          {save.error && <QueryError error={save.error} />}

          {confirm ? (
            <Alert variant="warning" data-testid="network-confirm">
              <div className="space-y-3">
                <AlertTitle>{n.confirmTitle}</AlertTitle>
                <AlertDescription>
                  <p>{n.confirmText}</p>
                  {affected.length > 0 && <p className="mt-1 font-medium">{affected.join(", ")}</p>}
                </AlertDescription>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={save.isPending} onClick={() => submit(true)}>
                    {save.isPending && <Spinner />} {n.confirmRestart}
                  </Button>
                  <Button variant="outline" disabled={save.isPending} onClick={() => submit(false)}>
                    {n.confirmNoRestart}
                  </Button>
                  <Button variant="ghost" onClick={() => setConfirm(false)}>
                    {t.common.cancel}
                  </Button>
                </div>
              </div>
            </Alert>
          ) : (
            <Button disabled={!valid || !rows || save.isPending} onClick={() => setConfirm(true)}>
              {n.save}
            </Button>
          )}
        </CardContent>
      </Card>

      {result && (
        <Card data-testid="network-result">
          <CardHeader>
            <CardTitle className="text-base">{n.resultTitle}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {result.servers.map((s) => (
              <div key={s.uuid} className="flex flex-wrap items-center gap-2 text-sm" data-testid="network-result-row">
                <span className="font-medium">{s.name}</span>
                <Badge variant="outline">{n.roles[s.role]}</Badge>
                <span className={s.error ? "text-destructive" : "text-muted-foreground"}>{s.error ? n.restartFailed(s.error) : s.restarted ? n.restarted : s.reloaded ? n.reloaded : n.notRunning}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Notice for backend servers (settings or console page): behind which proxy it sits. */
export function BackendNotice({ proxyName }: { proxyName: string }) {
  const t = useT();
  return (
    <Alert variant="info" data-testid="backend-notice">
      <div>{t.network.backendOf(proxyName)}</div>
    </Alert>
  );
}
