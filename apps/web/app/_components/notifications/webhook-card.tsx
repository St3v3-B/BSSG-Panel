"use client";
import { Bell } from "lucide-react";
import { useState } from "react";
import type { ServerNotifications, WebhookStatus } from "@panel/api";
import { DISCORD_WEBHOOK_RE } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

interface WebhookActions {
  /** Webhook opslaan (null = verwijderen); geeft de nieuwe status. */
  save: (url: string | null) => Promise<unknown>;
  test: () => Promise<unknown>;
}

/** Invoer voor een Discord-webhook met controle, opslaan, verwijderen en testbericht. */
function WebhookForm({ status, actions, id, extra, onSubmitExtra }: { status: WebhookStatus; actions: WebhookActions; id: string; extra?: React.ReactNode; onSubmitExtra?: () => Promise<unknown> }) {
  const t = useT().notify;
  const [url, setUrl] = useState("");
  const [state, setState] = useState<{ kind: "idle" | "saved" | "removed" | "tested" } | { kind: "error"; error: unknown }>({ kind: "idle" });
  const [busy, setBusy] = useState<null | "save" | "remove" | "test">(null);
  const trimmed = url.trim();
  const valid = DISCORD_WEBHOOK_RE.test(trimmed);
  const run = async (what: "save" | "remove" | "test", fn: () => Promise<unknown>, ok: "saved" | "removed" | "tested") => {
    setBusy(what);
    setState({ kind: "idle" });
    try {
      await fn();
      setState({ kind: ok });
      if (what !== "test") setUrl("");
    } catch (error) {
      setState({ kind: "error", error });
    } finally {
      setBusy(null);
    }
  };
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed && !valid) return;
        void run("save", async () => {
          if (trimmed) await actions.save(trimmed);
          else if (onSubmitExtra) await onSubmitExtra();
        }, "saved");
      }}
    >
      {extra}
      <div className="space-y-1.5">
        <Label htmlFor={id}>{t.webhookLabel}</Label>
        <Input
          id={id}
          type="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={status.set ? t.replacePlaceholder : "https://discord.com/api/webhooks/…"}
          value={url}
          aria-invalid={(trimmed && !valid) || undefined}
          onChange={(e) => (setUrl(e.target.value), setState({ kind: "idle" }))}
        />
        {trimmed && !valid ? <p className="text-xs text-destructive">{t.invalid}</p> : <p className="text-xs text-muted-foreground">{status.set ? t.currentHint(status.hint ?? "") : t.notSet}</p>}
      </div>
      {state.kind === "error" && <p className="text-sm text-destructive">{errorText(state.error)}</p>}
      {state.kind !== "idle" && state.kind !== "error" && (
        <p className="text-sm text-success" role="status">
          {t[state.kind]}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy !== null || (!!trimmed && !valid) || (!trimmed && !onSubmitExtra)}>
          {busy === "save" && <Spinner />} {t.save}
        </Button>
        <Button type="button" variant="outline" disabled={busy !== null || !status.set} onClick={() => void run("test", actions.test, "tested")}>
          {busy === "test" && <Spinner />} {t.sendTest}
        </Button>
        {status.set && (
          <Button type="button" variant="ghost" disabled={busy !== null} onClick={() => void run("remove", () => actions.save(null), "removed")}>
            {busy === "remove" && <Spinner />} {t.remove}
          </Button>
        )}
      </div>
    </form>
  );
}

function Shell({ testid, title, description, children }: { testid: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <Card data-testid={testid}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="size-4 text-muted-foreground" /> {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Eigen webhook op de accountpagina. */
export function AccountWebhookCard() {
  const t = useT().notify;
  const utils = trpc.useUtils();
  const q = trpc.account.webhook.useQuery();
  const set = trpc.account.setWebhook.useMutation({ onSuccess: (d) => utils.account.webhook.setData(undefined, d) });
  const test = trpc.account.testWebhook.useMutation();
  return (
    <Shell testid="account-webhook-card" title={t.accountTitle} description={t.accountText}>
      {q.data && <WebhookForm id="account-webhook" status={q.data} actions={{ save: (url) => set.mutateAsync({ url }), test: () => test.mutateAsync() }} />}
    </Shell>
  );
}

/** Admin-brede webhook. */
export function AdminWebhookCard() {
  const t = useT().notify;
  const utils = trpc.useUtils();
  const q = trpc.admin.notifications.get.useQuery();
  const set = trpc.admin.notifications.set.useMutation({ onSuccess: (d) => utils.admin.notifications.get.setData(undefined, d) });
  const test = trpc.admin.notifications.test.useMutation();
  return (
    <Shell testid="admin-webhook-card" title={t.adminTitle} description={t.adminText}>
      {q.data && <WebhookForm id="admin-webhook" status={q.data} actions={{ save: (url) => set.mutateAsync({ url }), test: () => test.mutateAsync() }} />}
    </Shell>
  );
}

/** Meldingen en auto-restart van één server (eigenaar). */
export function ServerNotificationsCard({ uuid }: { uuid: string }) {
  const q = trpc.servers.notifications.useQuery({ uuid });
  if (!q.data) return null;
  return <ServerNotificationsForm key={`${q.data.autoRestart}-${q.data.autoRestartMax}`} uuid={uuid} data={q.data} />;
}

function ServerNotificationsForm({ uuid, data }: { uuid: string; data: ServerNotifications }) {
  const t = useT().notify;
  const utils = trpc.useUtils();
  const [auto, setAuto] = useState(data.autoRestart);
  const [max, setMax] = useState(String(data.autoRestartMax));
  const update = trpc.servers.updateNotifications.useMutation({ onSuccess: (d) => utils.servers.notifications.setData({ uuid }, d) });
  const test = trpc.servers.testWebhook.useMutation();
  const n = Number(max);
  const maxOk = Number.isInteger(n) && n >= 1 && n <= 20;
  const dirty = auto !== data.autoRestart || n !== data.autoRestartMax;
  return (
    <Shell testid="server-notifications-card" title={t.serverTitle} description={t.serverText}>
      <WebhookForm
        id="server-webhook"
        status={data.webhook}
        actions={{
          save: (url) => update.mutateAsync({ uuid, webhookUrl: url, autoRestart: auto, autoRestartMax: maxOk ? n : data.autoRestartMax }),
          test: () => test.mutateAsync({ uuid }),
        }}
        onSubmitExtra={dirty && maxOk ? () => update.mutateAsync({ uuid, autoRestart: auto, autoRestartMax: n }) : undefined}
        extra={
          <div className="space-y-3 rounded-md border p-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox role="switch" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> {t.autoRestart}
            </label>
            <p className="text-xs text-muted-foreground">{t.autoRestartHint}</p>
            <div className="max-w-48 space-y-1.5">
              <Label htmlFor="auto-restart-max">{t.autoRestartMax}</Label>
              <Input id="auto-restart-max" type="number" min={1} max={20} inputMode="numeric" value={max} disabled={!auto} aria-invalid={!maxOk || undefined} onChange={(e) => setMax(e.target.value)} />
              {!maxOk && <p className="text-xs text-destructive">{t.autoRestartMaxError}</p>}
            </div>
          </div>
        }
      />
    </Shell>
  );
}
