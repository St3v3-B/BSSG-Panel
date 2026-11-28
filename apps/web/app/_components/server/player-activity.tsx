"use client";
import { ChevronLeft, ChevronRight, History, Moon, Play, Square, Sun, Users, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import type { ActivityRange, PlayerSession, ServerEventKind, ServerTimelineEvent } from "@panel/api";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { QueryError } from "@/app/_components/query-error";
import { Badge } from "@/app/_components/ui/badge";
import { Button } from "@/app/_components/ui/button";
import { Card } from "@/app/_components/ui/card";
import { EmptyState } from "@/app/_components/ui/empty-state";
import { Skeleton } from "@/app/_components/ui/skeleton";
import { Table } from "@/app/_components/ui/table";
import { formatDate, formatDuration } from "@/app/_lib/format";
import { intlLocale, useT } from "@/app/_lib/i18n";

const TZ = "Europe/Amsterdam";
const H = 3600_000;
const DAY = 24 * H;
const ROWS = 15;

const fmt = (opts: Intl.DateTimeFormatOptions) => {
  const f = new Intl.DateTimeFormat(intlLocale(), { timeZone: TZ, ...opts });
  return (d: Date) => f.format(d);
};

/** Kleur en icoon per servergebeurtenis (kleur is nooit de enige codering: ook icoon en label). */
const EVENT_STYLE: Record<ServerEventKind, { line: string; dot: string; icon: typeof Play }> = {
  start: { line: "bg-success/70", dot: "bg-success text-white", icon: Play },
  wake: { line: "bg-success/70", dot: "bg-success text-white", icon: Sun },
  stop: { line: "bg-muted-foreground/60", dot: "bg-muted-foreground text-background", icon: Square },
  sleep: { line: "bg-indigo-500/60", dot: "bg-indigo-500 text-white", icon: Moon },
  crash: { line: "bg-destructive/80", dot: "bg-destructive text-white", icon: Zap },
};

/** Tabblad Activiteit: wie er nu is, tijdlijn per speler, piekuren en een spelerstabel. */
export function PlayerActivityView({ uuid }: { uuid: string }) {
  const t = useT().playerActivity;
  const current = trpc.playerActivity.current.useQuery({ uuid }, { refetchInterval: 30_000, retry: false });

  if (current.error) return <QueryError error={current.error} />;
  if (current.data && !current.data.tracked) {
    return (
      <Card>
        <EmptyState icon={History} title={t.notTracked} data-testid="activity-untracked">
          {t.notTrackedText}
        </EmptyState>
      </Card>
    );
  }
  return (
    <div className="space-y-4" data-testid="player-activity">
      <div className="min-w-0 space-y-1">
        <h2 className="text-lg font-semibold tracking-tight">{t.title}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">{t.description}</p>
      </div>
      <CurrentPlayers sessions={current.data?.sessions} />
      <TimelineCard uuid={uuid} />
      <div className="grid gap-4 xl:grid-cols-2">
        <HeatmapCard uuid={uuid} />
        <PlayersCard uuid={uuid} />
      </div>
    </div>
  );
}

function CurrentPlayers({ sessions }: { sessions: PlayerSession[] | undefined }) {
  const t = useT().playerActivity;
  const time = fmt({ hour: "2-digit", minute: "2-digit" });
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium">
        <Users className="size-4 text-primary" /> {t.nowOnline}
        {sessions && <Badge variant={sessions.length ? "success" : "secondary"}>{sessions.length}</Badge>}
      </div>
      {!sessions ? (
        <Skeleton className="h-7 w-48" />
      ) : sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t.nobodyOnline}</p>
      ) : (
        <ul className="flex flex-wrap gap-2" data-testid="activity-current">
          {sessions.map((s) => (
            <li key={s.id} className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/40 px-3 py-1 text-sm">
              <span className="size-2 rounded-full bg-success" aria-hidden />
              <span className="font-medium">{s.name}</span>
              <span className="text-xs text-muted-foreground">{t.since(time(s.joinedAt))}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Toggle<T extends string | number>({ value, options, onChange, label, testId }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string; testId?: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-input bg-card/40 p-0.5" data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn("h-10 rounded-md px-3 text-sm font-medium transition-colors md:h-8", value === o.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

interface Row {
  name: string;
  total: number;
  sessions: PlayerSession[];
}

/** Sessies per speler, meeste speeltijd in het venster eerst. */
export function timelineRows(sessions: PlayerSession[], from: Date, to: Date): Row[] {
  const by = new Map<string, Row>();
  for (const s of sessions) {
    const k = s.name.toLowerCase();
    const r = by.get(k) ?? { name: s.name, total: 0, sessions: [] };
    r.sessions.push(s);
    r.total += Math.max(0, Math.min((s.leftAt ?? to).getTime(), to.getTime()) - Math.max(s.joinedAt.getTime(), from.getTime()));
    by.set(k, r);
  }
  return [...by.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Positie (0..100%) van een tijdstip in het venster. */
const pct = (d: Date, from: Date, to: Date) => Math.min(100, Math.max(0, ((d.getTime() - from.getTime()) / (to.getTime() - from.getTime())) * 100));

function TimelineCard({ uuid }: { uuid: string }) {
  const tt = useT();
  const t = tt.playerActivity;
  const [range, setRange] = useState<ActivityRange>("day");
  const [end, setEnd] = useState<Date | null>(null); // null = nu
  const [all, setAll] = useState(false);
  const q = trpc.playerActivity.timeline.useQuery({ uuid, range, ...(end ? { end } : {}) }, { refetchInterval: end ? false : 60_000, placeholderData: (p) => p, retry: false });
  const span = range === "day" ? DAY : 7 * DAY;
  const shift = (dir: -1 | 1) => {
    const base = end ?? q.data?.to ?? new Date();
    const next = new Date(base.getTime() + dir * span);
    setEnd(next.getTime() >= Date.now() - 5 * 60_000 ? null : next); // (bijna) nu: live venster
  };
  const data = q.data;
  const rows = useMemo(() => (data ? timelineRows(data.sessions, data.from, data.to) : []), [data]);
  const shown = all ? rows : rows.slice(0, ROWS);

  const ticks = useMemo(() => {
    if (!data) return [];
    const f = range === "day" ? fmt({ hour: "2-digit", minute: "2-digit" }) : fmt({ weekday: "short", day: "numeric" });
    // ticks op hele uren/dagen in Amsterdamse tijd
    const out: Array<{ at: Date; label: string }> = [];
    const first = Math.ceil(data.from.getTime() / H) * H;
    for (let x = first; x <= data.to.getTime(); x += H) {
      const d = new Date(x);
      const hour = Number(fmt({ hour: "2-digit", hourCycle: "h23" })(d));
      if (range === "day" ? hour % 3 === 0 : hour === 0) out.push({ at: d, label: f(d) });
    }
    return out;
  }, [data, range]);

  const time = fmt(range === "day" ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <Card className="p-4" data-testid="activity-timeline">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold">{t.timeline}</h3>
          <p className="text-xs text-muted-foreground">{data ? `${formatDate(data.from)} – ${formatDate(data.to)}` : t.timelineHint}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => shift(-1)} aria-label={t.earlier} data-testid="activity-earlier">
            <ChevronLeft />
          </Button>
          <Button variant="outline" size="sm" onClick={() => shift(1)} disabled={!end} aria-label={t.later} data-testid="activity-later">
            <ChevronRight />
          </Button>
          <Toggle value={range} onChange={(r) => (setRange(r), setEnd(null))} label={t.rangeLabel} options={(["day", "week"] as const).map((r) => ({ value: r, label: t.ranges[r] }))} testId="activity-range" />
        </div>
      </div>
      {q.error ? (
        <QueryError error={q.error} />
      ) : !data ? (
        <Skeleton className="h-48 w-full" />
      ) : (
        <>
          <Legend events={data.events} />
          {rows.length === 0 && data.events.length === 0 ? (
            <EmptyState icon={History} title={t.noSessions} className="py-8">
              {t.noSessionsText}
            </EmptyState>
          ) : (
            <div className="-mx-4 overflow-x-auto px-4">
              <div className="min-w-[36rem]">
                {/* as + gebeurtenissen */}
                <div className="flex">
                  <div className="w-28 shrink-0 sm:w-36" />
                  <div className="relative h-7 flex-1 border-b border-border" data-testid="activity-events">
                    {ticks.map((k) => (
                      <span key={k.at.getTime()} className="absolute bottom-0 -translate-x-1/2 whitespace-nowrap pb-1 text-[10px] tabular-nums text-muted-foreground" style={{ left: `${pct(k.at, data.from, data.to)}%` }}>
                        {k.label}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="relative">
                  {/* rasterlijnen en gebeurtenislijnen over alle rijen */}
                  <div className="pointer-events-none absolute inset-y-0 left-28 right-0 sm:left-36" aria-hidden>
                    {ticks.map((k) => (
                      <span key={k.at.getTime()} className="absolute inset-y-0 w-px bg-border/60" style={{ left: `${pct(k.at, data.from, data.to)}%` }} />
                    ))}
                    {data.events.map((e, i) => (
                      <span key={i} className={cn("absolute inset-y-0 w-0.5", EVENT_STYLE[e.kind].line)} style={{ left: `${pct(e.at, data.from, data.to)}%` }} />
                    ))}
                  </div>
                  <EventMarkers events={data.events} from={data.from} to={data.to} time={time} />
                  <ul aria-label={t.timeline}>
                    {shown.map((r) => (
                      <li key={r.name} className="flex items-center border-b border-border/40 py-1 last:border-b-0" data-testid="activity-row">
                        <div className="w-28 shrink-0 truncate pr-2 text-sm font-medium sm:w-36" title={r.name}>
                          {r.name}
                          <span className="block text-[11px] font-normal text-muted-foreground">{formatDuration(r.total)}</span>
                        </div>
                        <div className="relative h-5 flex-1">
                          {r.sessions.map((s) => {
                            const left = pct(s.joinedAt, data.from, data.to);
                            const right = pct(s.leftAt ?? data.to, data.from, data.to);
                            const dur = formatDuration((s.leftAt ?? new Date()).getTime() - s.joinedAt.getTime());
                            const label = t.sessionTitle(s.name, time(s.joinedAt), s.leftAt ? `${time(s.leftAt)}${s.endReason && s.endReason !== "leave" ? `, ${t.ended[s.endReason]}` : ""}` : t.stillOnline, dur);
                            return (
                              <span
                                key={s.id}
                                role="img"
                                aria-label={label}
                                title={label}
                                className={cn("absolute inset-y-0.5 min-w-1 rounded-sm", s.leftAt ? "bg-primary/75" : "bg-success ring-1 ring-success/40", s.endReason === "crash" && "bg-destructive/70")}
                                style={{ left: `${left}%`, width: `${Math.max(0.3, right - left)}%` }}
                              />
                            );
                          })}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            {data.truncated ? <span>{t.truncated}</span> : <span />}
            {rows.length > ROWS && (
              <Button variant="ghost" size="sm" onClick={() => setAll(!all)} data-testid="activity-show-all">
                {all ? t.showFewer : t.showAll(rows.length)}
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function Legend({ events }: { events: ServerTimelineEvent[] }) {
  const t = useT().playerActivity;
  const kinds = [...new Set(events.map((e) => e.kind))];
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground" data-testid="activity-legend">
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-4 rounded-sm bg-primary/75" aria-hidden /> {t.players}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2.5 w-4 rounded-sm bg-success" aria-hidden /> {t.online}
      </span>
      {kinds.map((k) => {
        const Icon = EVENT_STYLE[k].icon;
        return (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className={cn("grid size-4 place-items-center rounded-full [&_svg]:size-2.5", EVENT_STYLE[k].dot)} aria-hidden>
              <Icon />
            </span>
            {t.events[k]}
          </span>
        );
      })}
    </div>
  );
}

/** Kleine bolletjes met icoon bovenaan de rijen, met label voor schermlezers en tooltip. */
function EventMarkers({ events, from, to, time }: { events: ServerTimelineEvent[]; from: Date; to: Date; time: (d: Date) => string }) {
  const t = useT().playerActivity;
  if (!events.length) return null;
  return (
    <div className="flex">
      <div className="w-28 shrink-0 sm:w-36" />
      <ul className="relative h-5 flex-1" aria-label={t.timelineHint}>
        {events.map((e, i) => {
          const Icon = EVENT_STYLE[e.kind].icon;
          const label = `${t.events[e.kind]} ${time(e.at)}`;
          return (
            <li key={i} className={cn("absolute top-0.5 grid size-4 -translate-x-1/2 place-items-center rounded-full [&_svg]:size-2.5", EVENT_STYLE[e.kind].dot)} style={{ left: `${pct(e.at, from, to)}%` }} title={label} aria-label={label} data-kind={e.kind}>
              <Icon aria-hidden />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HeatmapCard({ uuid }: { uuid: string }) {
  const t = useT().playerActivity;
  const days = 28;
  const q = trpc.playerActivity.heatmap.useQuery({ uuid, days }, { staleTime: 5 * 60_000, retry: false });
  const nf = new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1 });
  return (
    <Card className="p-4" data-testid="activity-heatmap">
      <h3 className="font-semibold">{t.peak}</h3>
      <p className="mb-3 text-xs text-muted-foreground">{t.peakHint(days)}</p>
      {q.error ? (
        <QueryError error={q.error} />
      ) : !q.data ? (
        <Skeleton className="h-40 w-full" />
      ) : q.data.max === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t.peakEmpty}</p>
      ) : (
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[30rem] border-separate border-spacing-0.5 text-[10px]" role="grid">
            <thead>
              <tr>
                <th />
                {Array.from({ length: 24 }, (_, h) => (
                  <th key={h} scope="col" className="font-normal tabular-nums text-muted-foreground">
                    {h % 3 === 0 ? String(h).padStart(2, "0") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.cells.map((row, d) => (
                <tr key={d}>
                  <th scope="row" className="pr-1 text-left font-normal text-muted-foreground">
                    {t.weekdays[d]}
                  </th>
                  {row.map((v, h) => {
                    const label = t.peakCell(t.weekdays[d]!, `${String(h).padStart(2, "0")}:00`, nf.format(v));
                    const a = v / q.data!.max;
                    return (
                      <td key={h} title={label} aria-label={label} className="h-5 rounded-sm bg-muted/50 p-0" data-value={v}>
                        <span className="block size-full rounded-sm bg-primary" style={{ opacity: v > 0 ? 0.15 + 0.85 * a : 0 }} />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground" aria-hidden>
            {t.less}
            {[0.15, 0.4, 0.7, 1].map((o) => (
              <span key={o} className="size-3 rounded-sm bg-primary" style={{ opacity: o }} />
            ))}
            {t.more}
          </div>
        </div>
      )}
    </Card>
  );
}

function PlayersCard({ uuid }: { uuid: string }) {
  const t = useT().playerActivity;
  const [days, setDays] = useState(30);
  const q = trpc.playerActivity.players.useQuery({ uuid, days }, { placeholderData: (p) => p, refetchInterval: 60_000, retry: false });
  return (
    <Card className="p-4" data-testid="activity-players">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold">{t.players}</h3>
          <p className="text-xs text-muted-foreground">{t.playersHint(days)}</p>
        </div>
        <Toggle value={days} onChange={setDays} label={t.daysLabel} options={[7, 30, 90].map((d) => ({ value: d, label: String(d) }))} testId="activity-days" />
      </div>
      {q.error ? (
        <QueryError error={q.error} />
      ) : !q.data ? (
        <Skeleton className="h-40 w-full" />
      ) : q.data.players.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t.noPlayers}</p>
      ) : (
        <div className="max-h-[28rem] overflow-y-auto">
          <Table>
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-2 font-medium">{t.cols.name}</th>
                <th className="py-2 pr-2 font-medium">{t.cols.playtime}</th>
                <th className="py-2 pr-2 font-medium">{t.cols.sessions}</th>
                <th className="py-2 pr-2 font-medium">{t.cols.lastSeen}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.players.map((p) => (
                <tr key={p.name} className="border-t border-border/60" data-testid="activity-player">
                  <td className="py-2 pr-2 font-medium">
                    <span className="inline-flex items-center gap-2">
                      {p.name}
                      {p.online && <Badge variant="success">{t.onlineNow}</Badge>}
                    </span>
                  </td>
                  <td className="py-2 pr-2 tabular-nums">{formatDuration(p.totalSeconds * 1000)}</td>
                  <td className="py-2 pr-2 tabular-nums">{p.sessions}</td>
                  <td className="py-2 pr-2 text-muted-foreground">{p.online ? t.onlineNow : formatDate(p.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Card>
  );
}
