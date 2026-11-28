"use client";
import { Ban, Crown, Info, LogOut, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent, type ReactNode } from "react";
import type { OnlinePlayer, PlayerOp, PlayersInfo, ServerDetail } from "@panel/api";
import { isBedrockPlayerName, isValidPlayerName } from "@panel/api/players";
import { trpc } from "@/lib/trpc";
import { QueryError } from "@/app/_components/query-error";
import { Alert, AlertDescription } from "@/app/_components/ui/alert";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/app/_components/ui/card";
import { Dialog, DialogContent, DialogTitle } from "@/app/_components/ui/dialog";
import { Input } from "@/app/_components/ui/input";
import { Label } from "@/app/_components/ui/label";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Spinner } from "@/app/_components/ui/spinner";
import { errorInfo, errorText } from "@/app/_lib/errors";
import { useT } from "@/app/_lib/i18n";

const BAD_REASON = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** Grof: de server controleert IPv6 precies. */
const IPV6 = /^[0-9A-Fa-f:]{2,39}$/;
export const isIpAddress = (s: string) => IPV4.test(s) || (s.includes(":") && IPV6.test(s));
const reasonOk = (r: string) => r.length <= 200 && !BAD_REASON.test(r);

/** Kleur uit een naam/UUID: geen externe avatardienst, dus geen requests naar buiten. */
function hue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function PlayerAvatar({ name, uuid }: { name: string; uuid: string | null }) {
  const clean = name.replace(/^\./, "");
  const initials = (clean.match(/[A-Z0-9]/g)?.slice(0, 2).join("") || clean.slice(0, 2)).toUpperCase();
  const h = hue(uuid ?? name.toLowerCase());
  return (
    <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg text-xs font-semibold text-white" style={{ backgroundColor: `hsl(${h} 55% 42%)` }} data-testid="player-avatar">
      {initials}
    </span>
  );
}

function PlayerRow({ name, uuid, extra, actions }: { name: string; uuid: string | null; extra?: ReactNode; actions?: ReactNode }) {
  const t = useT().players;
  return (
    <li className="flex min-w-0 items-center gap-3 py-2" data-testid="player-row">
      <PlayerAvatar name={name} uuid={uuid} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="truncate font-medium">{name}</span>
          {isBedrockPlayerName(name) && <Badge variant="info">{t.bedrock}</Badge>}
          {extra}
        </div>
        {uuid && <p className="truncate font-mono text-xs text-muted-foreground" title={uuid}>{uuid}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </li>
  );
}

/** Formulier met naam (+ optionele reden) en een knop. */
function NameForm({ id, label, button, floodgate, withReason, pending, onSubmit, ipMode }: { id: string; label?: string; button: string; floodgate: boolean; withReason?: boolean; pending: boolean; onSubmit: (value: string, reason: string) => void; ipMode?: "ip" | "ipOrName" }) {
  const t = useT().players;
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const v = value.trim();
  const validName = isValidPlayerName(v, floodgate);
  const valid = ipMode === "ip" ? isIpAddress(v) : ipMode === "ipOrName" ? isIpAddress(v) || validName : validName;
  const showError = v.length > 0 && !valid;
  const reasonError = !reasonOk(reason);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid || reasonError || pending) return;
    onSubmit(v, reason.trim());
    setValue("");
    setReason("");
  };
  return (
    <form onSubmit={submit} className="space-y-2" noValidate>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor={`${id}-name`}>{label ?? t.nameLabel}</Label>
          <Input id={`${id}-name`} value={value} onChange={(e) => setValue(e.target.value)} placeholder={ipMode === "ip" ? t.ipPlaceholder : t.namePlaceholder} autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={45} aria-invalid={showError || undefined} />
        </div>
        {withReason && (
          <div className="min-w-0 flex-1 space-y-1.5">
            <Label htmlFor={`${id}-reason`}>{t.reasonLabel}</Label>
            <Input id={`${id}-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} aria-invalid={reasonError || undefined} />
          </div>
        )}
        <Button type="submit" disabled={!valid || reasonError || pending}>
          {pending && <Spinner />} {button}
        </Button>
      </div>
      {showError && <p className="text-xs text-destructive" role="alert">{ipMode === "ip" ? t.invalidIp : floodgate ? t.invalidNameBedrock : t.invalidName}</p>}
      {reasonError && <p className="text-xs text-destructive" role="alert">{t.invalidReason}</p>}
    </form>
  );
}

type Pending = { kind: "kick" | "ban"; player: OnlinePlayer } | null;

/** Tab Spelers: online spelers (live), whitelist, operators en bans. */
export function PlayersManager({ server }: { server: ServerDetail }) {
  const t = useT();
  const p = t.players;
  const uid = useId();
  const utils = trpc.useUtils();
  const canManage = server.permissions.includes("players.manage");
  const info = trpc.players.info.useQuery({ uuid: server.uuid });
  const online = trpc.players.online.useQuery({ uuid: server.uuid }, { refetchInterval: 10_000, enabled: !!info.data?.supported });
  const [dialog, setDialog] = useState<Pending>(null);
  const [reason, setReason] = useState("");
  const [banIp, setBanIp] = useState(false);
  const manage = trpc.players.manage.useMutation({
    onSuccess: (data) => {
      utils.players.info.setData({ uuid: server.uuid }, data);
      void utils.players.online.invalidate({ uuid: server.uuid });
    },
  });
  const run = (op: PlayerOp) => manage.mutate({ uuid: server.uuid, op });

  if (info.error) return <QueryError error={info.error} />;
  if (!info.data) return <Skeleton className="h-40 max-w-4xl rounded-xl" />;
  const s: PlayersInfo = info.data;
  if (!s.supported) {
    return (
      <Alert data-testid="players-unsupported">
        <Info />
        <AlertDescription>{server.templateSlug === "java-generic" ? p.notSupportedGeneric : p.notSupported}</AlertDescription>
      </Alert>
    );
  }
  const java = s.platform === "java";
  const edit = canManage && java;
  const busy = manage.isPending;
  const err = manage.error ? (p.errors as Record<string, string>)[errorInfo(manage.error).message.split(/[\s:]/)[0] ?? ""] ?? errorText(manage.error) : null;
  const o = online.data;
  const isOp = (n: string) => s.ops.some((x) => x.name.toLowerCase() === n.toLowerCase());

  const confirm = () => {
    if (!dialog || !reasonOk(reason)) return;
    const r = reason.trim() || undefined;
    if (dialog.kind === "kick") run({ action: "kick", name: dialog.player.name, reason: r });
    else {
      const name = dialog.player.name;
      // Eerst het IP (ban-ip op naam werkt alleen zolang de speler online is), dan de speler.
      const ban = () => run({ action: "ban", name, reason: r });
      if (banIp) manage.mutateAsync({ uuid: server.uuid, op: { action: "banIp", target: name, reason: r } }).then(ban, () => {});
      else ban();
    }
    setDialog(null);
  };

  return (
    <div className="max-w-4xl space-y-6" data-testid="players-manager">
      {!java && (
        <Alert>
          <Info />
          <AlertDescription>{p.proxyHint}</AlertDescription>
        </Alert>
      )}
      {java && !s.running && edit && (
        <Alert data-testid="players-stopped-note">
          <Info />
          <AlertDescription>{p.stoppedNote}</AlertDescription>
        </Alert>
      )}
      {err && (
        <Alert variant="destructive" data-testid="players-error">
          <AlertDescription>{err}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">{p.onlineTitle}</CardTitle>
            {o?.running && o.online !== null && <Badge variant="success" data-testid="players-count">{p.onlineCount(o.online, o.max)}</Badge>}
            <Button variant="ghost" size="icon-sm" className="ml-auto" aria-label={p.refresh} onClick={() => void online.refetch()} disabled={online.isFetching}>
              <RefreshCw className={online.isFetching ? "animate-spin" : undefined} />
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {online.error ? (
            <QueryError error={online.error} />
          ) : !o ? (
            <Skeleton className="h-12 rounded-lg" />
          ) : !o.running ? (
            <p className="text-sm text-muted-foreground" data-testid="players-offline">{p.stopped}</p>
          ) : o.players.length === 0 && (o.online ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">{p.noneOnline}</p>
          ) : (
            <>
              <ul className="divide-y divide-border" data-testid="players-online">
                {o.players.map((pl) => (
                  <PlayerRow
                    key={`${pl.server ?? ""}/${pl.name}`}
                    name={pl.name}
                    uuid={pl.uuid}
                    extra={
                      <>
                        {pl.server && <Badge variant="outline">{p.server(pl.server)}</Badge>}
                        {isOp(pl.name) && <Crown className="size-3.5 text-warning" aria-label={t.players.opsTitle} />}
                      </>
                    }
                    actions={
                      edit && s.running ? (
                        <>
                          {!isOp(pl.name) && (
                            <Button variant="ghost" size="icon-sm" aria-label={`${p.makeOp}: ${pl.name}`} title={p.makeOp} disabled={busy} onClick={() => run({ action: "op", name: pl.name })}>
                              <Crown />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon-sm" aria-label={p.kickTitle(pl.name)} title={p.kick} disabled={busy} onClick={() => (setReason(""), setDialog({ kind: "kick", player: pl }))}>
                            <LogOut />
                          </Button>
                          <Button variant="ghost" size="icon-sm" className="text-destructive" aria-label={p.banTitle(pl.name)} title={p.ban} disabled={busy} onClick={() => (setReason(""), setBanIp(false), setDialog({ kind: "ban", player: pl }))}>
                            <Ban />
                          </Button>
                        </>
                      ) : undefined
                    }
                  />
                ))}
              </ul>
              {!o.complete && <p className="mt-2 text-xs text-muted-foreground" data-testid="players-partial">{p.partial}</p>}
            </>
          )}
        </CardContent>
      </Card>

      {java && (
        <>
          {(!s.onlineMode || s.floodgate) && (
            <div className="space-y-1 text-xs text-muted-foreground">
              {!s.onlineMode && <p data-testid="players-offline-mode">{p.offlineMode}</p>}
              {s.floodgate && <p>{p.bedrockHint}</p>}
            </div>
          )}

          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="text-base">{p.whitelistTitle}</CardTitle>
                <Badge variant={s.whitelistEnabled ? "default" : "outline"} data-testid="whitelist-state">{s.whitelistEnabled ? p.on : p.off}</Badge>
                {edit && (
                  <Button variant="outline" size="sm" className="ml-auto" disabled={busy} onClick={() => run({ action: s.whitelistEnabled ? "whitelistOff" : "whitelistOn" })}>
                    <ShieldCheck /> {s.whitelistEnabled ? p.disableWhitelist : p.enableWhitelist}
                  </Button>
                )}
              </div>
              <CardDescription>{p.whitelistDesc}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {edit && <NameForm id={`${uid}-wl`} button={p.add} floodgate={s.floodgate} pending={busy} onSubmit={(name) => run({ action: "whitelistAdd", name })} />}
              {s.whitelist.length === 0 ? (
                <p className="text-sm text-muted-foreground">{p.whitelistEmpty}</p>
              ) : (
                <ul className="divide-y divide-border" data-testid="whitelist">
                  {s.whitelist.map((e) => (
                    <PlayerRow key={e.name} name={e.name} uuid={e.uuid} actions={edit && <IconButton label={p.remove(e.name)} disabled={busy} onClick={() => run({ action: "whitelistRemove", name: e.name })} />} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{p.opsTitle}</CardTitle>
              <CardDescription>{p.opsDesc}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {edit && <NameForm id={`${uid}-op`} button={p.makeOp} floodgate={s.floodgate} pending={busy} onSubmit={(name) => run({ action: "op", name })} />}
              {s.ops.length === 0 ? (
                <p className="text-sm text-muted-foreground">{p.opsEmpty}</p>
              ) : (
                <ul className="divide-y divide-border" data-testid="ops">
                  {s.ops.map((e) => (
                    <PlayerRow key={e.name} name={e.name} uuid={e.uuid} extra={<Badge variant="secondary">{p.level(e.level)}</Badge>} actions={edit && <IconButton label={p.deop(e.name)} disabled={busy} onClick={() => run({ action: "deop", name: e.name })} />} />
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{p.bansTitle}</CardTitle>
              <CardDescription>{p.bansDesc}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {edit && <NameForm id={`${uid}-ban`} button={p.ban} floodgate={s.floodgate} withReason pending={busy} onSubmit={(name, r) => run({ action: "ban", name, reason: r || undefined })} />}
              {s.bans.length === 0 ? (
                <p className="text-sm text-muted-foreground">{p.bansEmpty}</p>
              ) : (
                <ul className="divide-y divide-border" data-testid="bans">
                  {s.bans.map((e) => (
                    <PlayerRow
                      key={e.name}
                      name={e.name}
                      uuid={e.uuid}
                      extra={e.reason && <span className="min-w-0 truncate text-xs text-muted-foreground">{p.reasonShown(e.reason)}</span>}
                      actions={edit && <IconButton label={p.pardon(e.name)} disabled={busy} onClick={() => run({ action: "pardon", name: e.name })} />}
                    />
                  ))}
                </ul>
              )}

              <div className="space-y-3 border-t border-border pt-4">
                <p className="text-sm font-medium">{p.ipBansTitle}</p>
                {edit && <NameForm id={`${uid}-ip`} label={s.running ? p.ipLabelRunning : p.ipLabel} ipMode={s.running ? "ipOrName" : "ip"} button={p.banIp} floodgate={s.floodgate} withReason pending={busy} onSubmit={(target, r) => run({ action: "banIp", target, reason: r || undefined })} />}
                {s.ipBans.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{p.ipBansEmpty}</p>
                ) : (
                  <ul className="divide-y divide-border" data-testid="ip-bans">
                    {s.ipBans.map((e) => (
                      <li key={e.ip} className="flex min-w-0 items-center gap-3 py-2">
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-sm">{e.ip}</p>
                          {e.reason && <p className="truncate text-xs text-muted-foreground">{p.reasonShown(e.reason)}</p>}
                        </div>
                        {edit && <IconButton label={p.pardon(e.ip)} disabled={busy} onClick={() => run({ action: "pardonIp", ip: e.ip })} />}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={!!dialog} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent closeLabel={t.common.close}>
          {dialog && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                confirm();
              }}
            >
              <DialogTitle className="pr-10 text-lg font-semibold">{dialog.kind === "kick" ? p.kickTitle(dialog.player.name) : p.banTitle(dialog.player.name)}</DialogTitle>
              <div className="space-y-1.5">
                <Label htmlFor={`${uid}-dlg-reason`}>{p.reasonLabel}</Label>
                <Input id={`${uid}-dlg-reason`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} aria-invalid={!reasonOk(reason) || undefined} autoFocus />
                {!reasonOk(reason) && <p className="text-xs text-destructive">{p.invalidReason}</p>}
              </div>
              {dialog.kind === "ban" && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-primary" checked={banIp} onChange={(e) => setBanIp(e.target.checked)} /> {p.banIpToo}
                </label>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="outline" onClick={() => setDialog(null)}>{t.common.cancel}</Button>
                <Button type="submit" variant="destructive" disabled={!reasonOk(reason)}>{dialog.kind === "kick" ? p.kick : p.ban}</Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function IconButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Button variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-destructive" aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      <Trash2 />
    </Button>
  );
}
