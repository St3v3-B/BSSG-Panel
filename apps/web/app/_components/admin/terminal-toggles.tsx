"use client";
import { SquareTerminal } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/app/_components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

/** Admin, serverpagina: webterminal/SSH-shell voor deze server toestaan. */
export function TerminalAllowedSection({ uuid, allowed, globalEnabled }: { uuid: string; allowed: boolean; globalEnabled: boolean }) {
  const d = useT().devaccess.admin;
  const utils = trpc.useUtils();
  const m = trpc.admin.servers.setTerminalAllowed.useMutation({ onSuccess: () => utils.servers.get.invalidate({ uuid }) });
  return (
    <Card data-testid="terminal-allowed-section">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SquareTerminal className="size-5 text-muted-foreground" /> {d.serverToggle}
        </CardTitle>
        <CardDescription>{d.serverToggleText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={allowed} disabled={m.isPending} onChange={(e) => m.mutate({ uuid, allowed: e.target.checked })} data-testid="terminal-allowed" />
          {allowed ? d.on : d.off}
        </label>
        {!globalEnabled && <p className="text-xs text-muted-foreground">{d.globalToggleText}</p>}
        {m.error && <p className="text-sm text-destructive">{errorText(m.error)}</p>}
      </CardContent>
    </Card>
  );
}

/** Admin, instellingen: webterminal/SSH-shell globaal aan of uit (direct opgeslagen). */
export function TerminalSettingsCard() {
  const d = useT().devaccess.admin;
  const utils = trpc.useUtils();
  const q = trpc.admin.settings.get.useQuery();
  const m = trpc.admin.settings.update.useMutation({ onSuccess: (s) => utils.admin.settings.get.setData(undefined, s) });
  if (!q.data) return <Skeleton className="h-28 rounded-xl" />;
  const on = q.data.terminalEnabled;
  return (
    <Card data-testid="terminal-settings">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <SquareTerminal className="size-5 text-muted-foreground" /> {d.globalToggle}
          </CardTitle>
          <Badge variant={on ? "success" : "secondary"}>{on ? d.on : d.off}</Badge>
        </div>
        <CardDescription>{d.globalToggleText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={on} disabled={m.isPending} onChange={(e) => m.mutate({ terminalEnabled: e.target.checked })} data-testid="terminal-enabled" />
          {d.globalToggle}
        </label>
        {m.error && <p className="text-sm text-destructive">{errorText(m.error)}</p>}
      </CardContent>
    </Card>
  );
}
