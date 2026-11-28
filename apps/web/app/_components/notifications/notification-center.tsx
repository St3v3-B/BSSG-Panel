"use client";
import { AlertTriangle, Bell, CheckCheck, CheckCircle2, Info, Mail, XCircle } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ADMIN_NOTIFICATION_EVENTS, NotificationEvent, type ChannelPrefs, type InboxItem, type NotificationChannel, type NotificationSettings } from "@panel/api/schemas";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Checkbox } from "@/app/_components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/app/_components/ui/dropdown-menu";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorText } from "@/app/_lib/errors";
import { formatDate } from "@/app/_lib/format";
import { useT } from "@/app/_lib/i18n";
import { cn } from "@/lib/utils";

const LEVEL_ICON = { error: XCircle, warning: AlertTriangle, success: CheckCircle2, info: Info } as const;
const LEVEL_COLOR = { error: "text-destructive", warning: "text-warning", success: "text-success", info: "text-primary" } as const;

/** Bel in de kopbalk: ongelezen teller en de laatste meldingen. */
export function NotificationBell() {
  const t = useT().notif2;
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const count = trpc.inbox.unreadCount.useQuery(undefined, { refetchInterval: 60_000, refetchOnWindowFocus: true });
  const list = trpc.inbox.list.useInfiniteQuery({ limit: 15 }, { enabled: open, getNextPageParam: (p) => p.nextCursor ?? undefined });
  const markRead = trpc.inbox.markRead.useMutation({
    onSuccess: () => {
      void utils.inbox.unreadCount.invalidate();
      void utils.inbox.list.invalidate();
    },
  });
  const n = count.data?.count ?? 0;
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={n ? t.bellUnread(n) : t.bell} data-testid="notification-bell">
          <Bell className="size-4.5" />
          {n > 0 && (
            <span className="absolute -right-0.5 -top-0.5 grid min-w-4.5 place-items-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4.5 text-white" data-testid="unread-count">
              {n > 99 ? "99+" : n}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(24rem,calc(100vw-1rem))] p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <span className="text-sm font-semibold">{t.bell}</span>
          <Button variant="ghost" size="sm" disabled={!n || markRead.isPending} onClick={() => markRead.mutate({})}>
            <CheckCheck /> {t.markAllRead}
          </Button>
        </div>
        <div className="max-h-[min(28rem,70dvh)] overflow-y-auto">
          {list.isLoading && (
            <div className="grid place-items-center p-6">
              <Spinner />
            </div>
          )}
          {!list.isLoading && !items.length && <p className="p-6 text-center text-sm text-muted-foreground">{t.empty}</p>}
          <ul>
            {items.map((it) => (
              <InboxRow key={it.id} item={it} onOpen={() => (it.readAt ? undefined : markRead.mutate({ ids: [it.id] }), setOpen(false))} />
            ))}
          </ul>
          {list.hasNextPage && (
            <div className="p-2">
              <Button variant="ghost" size="sm" className="w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage && <Spinner />} {t.loadMore}
              </Button>
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InboxRow({ item, onOpen }: { item: InboxItem; onOpen: () => void }) {
  const Icon = LEVEL_ICON[item.level];
  const body = (
    <div className={cn("flex gap-3 px-3 py-2.5", !item.readAt && "bg-accent/40")}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", LEVEL_COLOR[item.level])} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className={cn("truncate text-sm", !item.readAt && "font-semibold")}>{item.title}</span>
          <time className="shrink-0 text-xs text-muted-foreground" dateTime={item.createdAt.toISOString()}>
            {formatDate(item.createdAt)}
          </time>
        </div>
        <p className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{item.body}</p>
      </div>
    </div>
  );
  return (
    <li className="border-b border-border last:border-0" data-testid="inbox-item">
      {item.link ? (
        <Link href={item.link} onClick={onOpen} className="block hover:bg-accent">
          {body}
        </Link>
      ) : (
        <button type="button" onClick={onOpen} className="block w-full text-left hover:bg-accent">
          {body}
        </button>
      )}
    </li>
  );
}

// ---------- accountpagina ----------

const CHANNELS: NotificationChannel[] = ["panel", "discord", "email"];

/** E-mailadres en de tabel met kanalen per gebeurtenis. */
export function NotificationSettingsCards({ isAdmin }: { isAdmin: boolean }) {
  const q = trpc.account.notificationSettings.useQuery();
  if (!q.data) return null;
  return (
    <>
      <EmailCard settings={q.data} />
      <PrefsCard settings={q.data} isAdmin={isAdmin} />
    </>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function EmailCard({ settings }: { settings: NotificationSettings }) {
  const t = useT().notif2;
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = () => utils.account.notificationSettings.invalidate();
  const set = trpc.account.setEmail.useMutation({ onSuccess: () => void refresh() });
  const resend = trpc.account.resendEmailVerification.useMutation();
  const test = trpc.account.testEmail.useMutation();
  const busy = set.isPending || resend.isPending || test.isPending;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    }
  };
  const trimmed = email.trim();
  const valid = EMAIL_RE.test(trimmed);
  const { address, pending } = settings.email;
  return (
    <Card data-testid="email-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="size-4 text-muted-foreground" /> {t.emailTitle}
        </CardTitle>
        <CardDescription>{t.emailText}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!settings.emailAvailable && <p className="text-sm text-warning">{t.emailUnavailable}</p>}
        <p className="text-sm text-muted-foreground" role="status">
          {address ? t.emailCurrent(address) : t.emailNone}
          {pending && <span className="mt-1 block">{t.emailPending(pending)}</span>}
        </p>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            void run(() => set.mutateAsync({ email: trimmed }).then(() => setEmail("")), t.emailSent);
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="account-email">{t.emailLabel}</Label>
            <Input id="account-email" type="email" autoComplete="email" value={email} placeholder="you@example.com" disabled={!settings.emailAvailable} aria-invalid={(trimmed && !valid) || undefined} onChange={(e) => (setEmail(e.target.value), setMsg(null))} />
            {trimmed && !valid && <p className="text-xs text-destructive">{t.emailInvalid}</p>}
          </div>
          {msg && <p className={cn("text-sm", msg.ok ? "text-success" : "text-destructive")}>{msg.text}</p>}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy || !valid || !settings.emailAvailable}>
              {set.isPending && <Spinner />} {t.emailSave}
            </Button>
            {pending && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => resend.mutateAsync(), t.emailSent)}>
                {t.emailResend}
              </Button>
            )}
            {address && (
              <Button type="button" variant="outline" disabled={busy} onClick={() => void run(() => test.mutateAsync(), t.emailTested)}>
                {test.isPending && <Spinner />} {t.emailTest}
              </Button>
            )}
            {(address || pending) && (
              <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(() => set.mutateAsync({ email: null }), t.emailRemoved)}>
                {t.emailRemove}
              </Button>
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function PrefsCard({ settings, isAdmin }: { settings: NotificationSettings; isAdmin: boolean }) {
  const t = useT().notif2;
  const utils = trpc.useUtils();
  const save = trpc.account.setNotificationPrefs.useMutation({ onSuccess: (d) => utils.account.notificationSettings.setData(undefined, d) });
  const events = NotificationEvent.options.filter((e) => isAdmin || !ADMIN_NOTIFICATION_EVENTS.includes(e));
  const unavailable: Record<NotificationChannel, string | null> = {
    panel: null,
    discord: settings.discordSet ? null : t.discordMissing,
    email: settings.email.address && settings.emailAvailable ? null : t.emailMissing,
  };
  const toggle = (e: (typeof events)[number], c: NotificationChannel, v: boolean) => {
    const next: ChannelPrefs = { ...settings.prefs[e], [c]: v };
    save.mutate({ prefs: { [e]: next } });
  };
  return (
    <Card data-testid="notification-prefs">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Bell className="size-4 text-muted-foreground" /> {t.prefsTitle}
        </CardTitle>
        <CardDescription>{t.prefsText}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-2 pr-3 font-medium">{t.event}</th>
              {CHANNELS.map((c) => (
                <th key={c} className="px-2 py-2 text-center font-medium">
                  {t.channels[c]}
                  {unavailable[c] && (
                    <Badge variant="secondary" className="ml-1 align-middle" title={unavailable[c]!}>
                      !
                    </Badge>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e} className="border-t border-border">
                <td className="py-2 pr-3">{t.events[e]}</td>
                {CHANNELS.map((c) => (
                  <td key={c} className="px-2 py-2 text-center">
                    <Checkbox
                      aria-label={`${t.events[e]}: ${t.channels[c]}`}
                      checked={settings.prefs[e][c]}
                      disabled={save.isPending}
                      title={unavailable[c] ?? undefined}
                      onChange={(ev) => toggle(e, c, ev.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {(unavailable.discord || unavailable.email) && (
          <p className="mt-3 text-xs text-muted-foreground">{[unavailable.discord, unavailable.email].filter(Boolean).join(" · ")}</p>
        )}
        {save.error && <p className="mt-2 text-sm text-destructive">{errorText(save.error)}</p>}
      </CardContent>
    </Card>
  );
}
