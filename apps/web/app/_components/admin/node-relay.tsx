"use client";
/** Admin → Node: HTTP(S)-ingang (eigen 80/443 of via een relay-node), tunnelstatus en DNS-records. */
import { AlertTriangle, ArrowRightLeft } from "lucide-react";
import { useState } from "react";
import type { Node } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { useT } from "@/app/_lib/i18n";
import { AdminError } from "./nodes";

/** Waarde van de keuzelijst: "" = eigen poorten, anders het node-id. */
const toValue = (id: number | null) => (id === null ? "" : String(id));

export function NodeHttpRelay({ node }: { node: Node }) {
  const t = useT();
  const r = t.admin.nodes.relay;
  const utils = trpc.useUtils();
  const st = trpc.admin.nodes.relayStatus.useQuery({ id: node.id }, { refetchInterval: 15_000 });
  const [choice, setChoice] = useState<string | null>(null);
  const set = trpc.admin.nodes.setHttpRelay.useMutation({
    onSuccess: () => {
      setChoice(null);
      void utils.admin.nodes.relayStatus.invalidate({ id: node.id });
      void utils.admin.nodes.get.invalidate({ id: node.id });
      void utils.admin.nodes.list.invalidate();
    },
  });
  if (st.error) return <AdminError error={st.error} />;
  if (!st.data) return <Skeleton className="h-40 rounded-xl" />;
  const s = st.data;
  const current = toValue(s.relayNodeId);
  const selected = choice ?? current;
  const dirty = selected !== current;
  const target = s.candidates.find((c) => String(c.id) === selected);
  const relayName = s.candidates.find((c) => c.id === s.relayNodeId)?.name ?? String(s.relayNodeId);

  return (
    <Card data-testid="node-http-relay">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ArrowRightLeft className="size-4" /> {r.title}
          {s.relayNodeId !== null && <Badge variant="info">{r.badge(relayName)}</Badge>}
        </CardTitle>
        <CardDescription>{r.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {node.isLocal ? (
          <p className="text-muted-foreground">{r.localNote}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <label htmlFor={`relay-${node.id}`} className="text-sm font-medium">
                {r.via}
              </label>
              <Select id={`relay-${node.id}`} value={selected} onChange={(e) => setChoice(e.target.value)} data-testid="relay-select" disabled={s.clients.length > 0}>
                <option value="">{r.own}</option>
                {s.candidates.map((c) => (
                  <option key={c.id} value={String(c.id)}>
                    {r.viaNode(c.name, c.fqdn)}
                  </option>
                ))}
              </Select>
            </div>
            {dirty && (
              <>
                <Button onClick={() => set.mutate({ id: node.id, relayNodeId: selected === "" ? null : Number(selected) })} disabled={set.isPending} data-testid="relay-apply">
                  {set.isPending && <Spinner />} {r.apply}
                </Button>
                <Button variant="ghost" onClick={() => setChoice(null)}>
                  {t.common.cancel}
                </Button>
              </>
            )}
          </div>
        )}
        {!node.isLocal && s.candidates.length === 0 && s.relayNodeId === null && <p className="text-xs text-muted-foreground">{r.noCandidates}</p>}
        {dirty && (
          <Alert variant="warning" data-testid="relay-warning">
            <AlertTriangle />
            <div>
              <AlertTitle>{r.warnTitle}</AlertTitle>
              <AlertDescription>
                {target ? r.warnText(target.fqdn) : r.warnOwn} {r.gameNote}
              </AlertDescription>
            </div>
          </Alert>
        )}
        {set.error && <AdminError error={set.error} />}
        {set.data && (
          <p className="text-xs text-success" role="status">
            {r.saved}
          </p>
        )}

        {s.relayNodeId !== null && (
          <div className="grid gap-3 sm:grid-cols-2" data-testid="relay-tunnel">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">{r.tunnel}</div>
              {s.tunnel ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={s.tunnel.connected ? "success" : "destructive"}>{s.tunnel.connected ? r.connected : r.disconnected}</Badge>
                  {s.tunnel.latencyMs !== null && <span>{r.latency(s.tunnel.latencyMs)}</span>}
                  {s.tunnel.reconnects > 0 && <span className="text-xs text-muted-foreground">{r.reconnects(s.tunnel.reconnects)}</span>}
                </div>
              ) : (
                <Badge variant="secondary">{r.unknown}</Badge>
              )}
              {s.tunnel?.lastError && (
                <p className="text-xs text-destructive">
                  {r.lastError}: {s.tunnel.lastError}
                </p>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">{r.edgeView}</div>
              {s.edge ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={s.edge.connected ? "success" : "destructive"}>{s.edge.connected ? r.connected : r.disconnected}</Badge>
                  {s.edge.latencyMs !== null && <span>{r.latency(s.edge.latencyMs)}</span>}
                  {s.edge.lastError && <span className="text-xs text-destructive">{s.edge.lastError}</span>}
                </div>
              ) : (
                <Badge variant="warning">{r.edgeUnreachable}</Badge>
              )}
            </div>
          </div>
        )}

        {s.modeCommand && ((s.relayNodeId !== null && s.tunnel?.httpMode === "direct") || dirty || set.data) && (
          <div className="space-y-1" data-testid="relay-mode-command">
            <p className="text-xs text-muted-foreground">{(dirty ? selected !== "" : s.relayNodeId !== null) ? r.modeDirect : r.modeRelay}</p>
            <div className="flex items-start gap-1 rounded-md border border-border bg-background/60 px-3 py-2">
              <code className="flex-1 break-all font-mono text-xs">{dirty ? s.modeCommand.replace(/--http-mode \w+$/, `--http-mode ${selected === "" ? "direct" : "relay"}`) : s.modeCommand}</code>
              <CopyButton value={dirty ? s.modeCommand.replace(/--http-mode \w+$/, `--http-mode ${selected === "" ? "direct" : "relay"}`) : s.modeCommand} label={t.common.copyX(r.title)} />
            </div>
          </div>
        )}

        {(set.data?.dns ?? s.dns).length > 0 && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">
              {r.dnsTitle}
              {s.httpIp && (
                <>
                  {" → "}
                  <code className="font-mono text-foreground">{s.httpIp}</code>
                </>
              )}
            </div>
            <ul className="divide-y divide-border rounded-md border border-border" data-testid="relay-dns">
              {(set.data?.dns ?? s.dns).map((d) => (
                <li key={d.name} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
                  <code className="font-mono text-xs">
                    {d.name} A {d.value ?? "?"}
                  </code>
                  <span className="flex gap-1.5">
                    {d.applied === true && <Badge variant="success">{r.dnsApplied}</Badge>}
                    {d.applied === false && <Badge variant="destructive">{d.error ? `${r.dnsFailed}: ${d.error}` : r.dnsFailed}</Badge>}
                    {d.applied === null && <Badge variant="secondary">{d.managed ? r.dnsManaged : r.dnsManual}</Badge>}
                    {d.ok !== null && <Badge variant={d.ok ? "success" : "warning"}>{d.ok ? r.dnsOk : r.dnsWrong}</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {s.clients.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">{r.clients}</div>
            <ul className="flex flex-wrap gap-1.5">
              {s.clients.map((c) => (
                <li key={c.id}>
                  <Badge variant="secondary">
                    {c.name} ({c.fqdn})
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
