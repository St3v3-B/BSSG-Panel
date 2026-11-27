"use client";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { ServerDetail } from "@panel/api";
import { bedrockPlatform } from "@panel/api/network";
import { trpc } from "@/lib/trpc";
import { CopyButton } from "@/app/_components/copy-button";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription, AlertTitle } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Select } from "@/app/_components/ui/select";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { useT } from "@/app/_lib/i18n";

/** Bedrock tab: toggle Geyser + Floodgate, pick the UDP port, show the address players enter. */
export function BedrockManager({ server }: { server: ServerDetail }) {
  const t = useT();
  const b = t.bedrock;
  const utils = trpc.useUtils();
  const status = trpc.servers.bedrock.useQuery({ uuid: server.uuid });
  const [allocationId, setAllocationId] = useState<number | undefined>(undefined);
  const [restart, setRestart] = useState(true);
  const set = trpc.servers.setBedrock.useMutation({
    onSuccess: () => {
      void utils.servers.bedrock.invalidate({ uuid: server.uuid });
      void utils.servers.get.invalidate({ uuid: server.uuid });
    },
  });
  if (status.error) return <QueryError error={status.error} />;
  if (!status.data) return <Skeleton className="h-40 max-w-3xl rounded-xl" />;
  const s = status.data;
  const address = s.address && s.port ? `${s.address}:${s.port}` : null;
  const pick = allocationId ?? s.freeAllocations[0]?.id;

  return (
    <div className="max-w-3xl space-y-6" data-testid="bedrock-manager">
      <p className="text-sm text-muted-foreground">{s.mode === "proxy" ? b.introProxy : b.intro}</p>

      {s.mode === "backend" && (
        <Alert>
          <div>
            <AlertTitle>{b.backendTitle}</AlertTitle>
            <AlertDescription>{b.backendText}</AlertDescription>
          </div>
        </Alert>
      )}

      {s.supported && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">{b.title}</CardTitle>
              <Badge variant={s.enabled ? "default" : "outline"} data-testid="bedrock-state">{s.enabled ? b.on : b.off}</Badge>
            </div>
            <CardDescription>{bedrockPlatform(server.templateName.toLowerCase()) === "fabric" ? b.whatFabric : b.what}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {s.enabled && address && (
              <div className="space-y-2" data-testid="bedrock-address">
                <p className="text-sm font-medium">{b.joinTitle}</p>
                <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted-foreground">{b.address}</dt>
                  <dd className="flex items-center gap-1">
                    <code className="rounded bg-muted px-2 py-0.5 font-mono" data-testid="bedrock-host">{s.address}</code>
                    <CopyButton value={s.address!} />
                  </dd>
                  <dt className="text-muted-foreground">{b.port}</dt>
                  <dd className="flex items-center gap-1">
                    <code className="rounded bg-muted px-2 py-0.5 font-mono" data-testid="bedrock-port">{s.port}</code>
                    <CopyButton value={String(s.port)} />
                  </dd>
                </dl>
                <p className="text-xs text-muted-foreground">{b.joinHint}</p>
              </div>
            )}

            {s.enabled && (
              <Alert variant="warning" data-testid="bedrock-firewall">
                <TriangleAlert />
                <div>
                  <AlertTitle>{b.firewallTitle}</AlertTitle>
                  <AlertDescription>{b.firewallText(s.port!)}</AlertDescription>
                </div>
              </Alert>
            )}

            {!s.enabled && (
              <div className="space-y-2">
                {s.freeAllocations.length === 0 ? (
                  <p className="text-sm text-destructive" data-testid="bedrock-nofree">{b.noFree}</p>
                ) : (
                  <label className="flex flex-wrap items-center gap-2 text-sm">
                    {b.portLabel}
                    <Select
                      aria-label={b.portLabel}
                      className="w-auto font-mono"
                      value={pick}
                      onChange={(e) => setAllocationId(Number(e.target.value))}
                    >
                      {s.freeAllocations.map((f) => (
                        <option key={f.id} value={f.id}>{f.ip}:{f.port} (UDP)</option>
                      ))}
                    </Select>
                  </label>
                )}
              </div>
            )}

            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-primary" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
              {s.mode === "proxy" ? b.restartProxy : b.restart}
            </label>

            {set.error && <QueryError error={set.error} />}
            <div className="flex flex-wrap gap-2">
              {s.enabled ? (
                <Button variant="outline" disabled={set.isPending} onClick={() => set.mutate({ uuid: server.uuid, enabled: false, restart })}>
                  {set.isPending && <Spinner />} {b.disable}
                </Button>
              ) : (
                <Button disabled={set.isPending || pick === undefined} onClick={() => set.mutate({ uuid: server.uuid, enabled: true, allocationId: pick, restart })}>
                  {set.isPending && <Spinner />} {b.enable}
                </Button>
              )}
            </div>
            {s.enabled && <p className="text-xs text-muted-foreground">{b.disableHint}</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
