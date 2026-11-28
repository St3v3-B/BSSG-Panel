"use client";
import { KeyRound, ShieldOff, SquareTerminal } from "lucide-react";
import Link from "next/link";
import { CopyButton } from "@/app/_components/copy-button";
import { NoPermission } from "@/app/_components/server/no-permission";
import { WebTerminal } from "@/app/_components/server/web-terminal";
import { Card, CardContent } from "@/app/_components/ui/card";
import { useServer } from "@/app/_hooks/use-server";
import { useT } from "@/app/_lib/i18n";

export default function TerminalPage() {
  const server = useServer();
  const t = useT();
  const tt = t.devaccess.terminal;
  const s = server.data;
  if (!s) return null;
  if (!s.permissions.includes("terminal") || !s.permissions.includes("files.write")) return <NoPermission>{tt.noPermission}</NoPermission>;
  if (!s.terminal.enabled) {
    return (
      <Card className="grid min-h-48 place-items-center p-6 text-center text-sm text-muted-foreground" data-testid="terminal-disabled">
        <div className="max-w-md space-y-2">
          <ShieldOff className="mx-auto size-6" />
          <p>{s.suspended ? t.errors.messages.SUSPENDED : !s.terminal.globalEnabled ? tt.disabledGlobal : tt.disabled}</p>
        </div>
      </Card>
    );
  }
  const ssh = `ssh -p ${s.sftp.port} ${s.sftp.username}@${s.sftp.host}`;
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-sm text-muted-foreground">
        <SquareTerminal className="mt-0.5 size-4 shrink-0" />
        <p>{tt.intro}</p>
      </div>
      <WebTerminal uuid={s.uuid} />
      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="size-4" /> {tt.sshTitle}
          </div>
          <p className="text-sm text-muted-foreground">{tt.sshText}</p>
          <div className="flex items-center gap-1 rounded-md border border-border bg-muted/30 px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-sm" data-testid="terminal-ssh">
              {ssh}
            </code>
            <CopyButton value={ssh} label={t.common.copyX("SSH")} />
          </div>
          <p className="text-xs text-muted-foreground">
            {tt.sshKeysHint}{" "}
            <Link href="/account#api-keys" className="text-primary underline-offset-4 hover:underline">
              {t.devaccess.apiKeys.title}
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
