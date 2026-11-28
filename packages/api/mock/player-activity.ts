/** Mock voor de tab Activiteit: deterministische sessies en servergebeurtenissen van de afgelopen 30 dagen. */
import { playersPlatform } from "../players";
import type { PlayerSession, ServerTimelineEvent } from "../player-activity";
import type * as s from "../schemas";
import type { Implementation } from "../trpc-builder";

interface Deps {
  server: (uuid: string) => { uuid: string; templateSlug: string; status: s.ServerStatus; type: "game" | "web" };
}

const NAMES = ["Steve", "Alex", ".PocketPlayer", "Builder_99", "RedstoneRita", "CaveDweller", "NightOwl_7"];
const H = 3600_000;
const DAY = 24 * H;

/** Kleine deterministische generator. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

function generate(uuid: string, running: boolean, now: number) {
  const r = rng([...uuid].reduce((a, c) => a * 31 + c.charCodeAt(0), 7));
  const sessions: PlayerSession[] = [];
  const events: ServerTimelineEvent[] = [];
  let id = 1;
  const start = now - 30 * DAY;
  // Elke dag: server start 's middags, slaapt 's nachts; avonden druk.
  for (let d = 0; d <= 30; d++) {
    const day = Math.floor((start + d * DAY) / DAY) * DAY;
    const wake = day + 11 * H + Math.floor(r() * 2 * H);
    const sleep = day + 23 * H + Math.floor(r() * 2 * H);
    if (wake > now) break;
    events.push({ at: new Date(wake), kind: d % 6 === 0 ? "start" : "wake" });
    const end = Math.min(sleep, now);
    for (const name of NAMES) {
      if (r() < 0.35) continue;
      let t = wake + Math.floor(r() * 5 * H);
      while (t < end) {
        const len = Math.floor((0.3 + r() * 2.5) * H);
        const left = t + len;
        const open = left >= end && end === now && running;
        sessions.push({ id: id++, name, uuid: name.startsWith(".") ? null : `00000000-0000-4000-8000-${String(NAMES.indexOf(name)).padStart(12, "0")}`, joinedAt: new Date(t), leftAt: open ? null : new Date(Math.min(left, end)), endReason: open ? null : left >= end ? (d === 12 ? "crash" : "sleep") : "leave" });
        t = left + Math.floor((0.5 + r() * 3) * H);
      }
    }
    if (sleep <= now) {
      if (d === 12) events.push({ at: new Date(sleep), kind: "crash" });
      else events.push({ at: new Date(sleep), kind: d % 6 === 5 ? "stop" : "sleep" });
    }
  }
  return { sessions, events };
}

export function createPlayerActivityMock(d: Deps): Implementation["playerActivity"] {
  const data = (uuid: string) => {
    const x = d.server(uuid);
    const tracked = x.type === "game" && !!playersPlatform(x.templateSlug);
    return { tracked, ...(tracked ? generate(uuid, x.status === "online", Date.now()) : { sessions: [], events: [] }) };
  };
  return {
    timeline: ({ input }) => {
      const g = data(input.uuid);
      const to = input.end && input.end.getTime() < Date.now() ? input.end : new Date();
      const from = new Date(to.getTime() - (input.range === "day" ? DAY : 7 * DAY));
      return {
        tracked: g.tracked,
        range: input.range,
        from,
        to,
        sessions: g.sessions.filter((s) => s.joinedAt < to && (s.leftAt ?? to) >= from),
        events: g.events.filter((e) => e.at >= from && e.at <= to),
        truncated: false,
      };
    },
    players: ({ input }) => {
      const g = data(input.uuid);
      const now = Date.now();
      const from = now - input.days * DAY;
      const by = new Map<string, { name: string; uuid: string | null; sessions: number; total: number; first: number; last: number; online: boolean }>();
      for (const s of g.sessions) {
        const end = s.leftAt?.getTime() ?? now;
        if (end < from) continue;
        const p = by.get(s.name) ?? { name: s.name, uuid: s.uuid, sessions: 0, total: 0, first: s.joinedAt.getTime(), last: 0, online: false };
        p.sessions++;
        p.total += end - Math.max(from, s.joinedAt.getTime());
        p.first = Math.min(p.first, s.joinedAt.getTime());
        p.last = Math.max(p.last, end);
        p.online ||= !s.leftAt;
        by.set(s.name, p);
      }
      const players = [...by.values()]
        .sort((a, b) => Number(b.online) - Number(a.online) || b.last - a.last)
        .map((p) => ({ name: p.name, uuid: p.uuid, sessions: p.sessions, totalSeconds: Math.round(p.total / 1000), firstSeen: new Date(p.first), lastSeen: new Date(p.last), online: p.online }));
      return { tracked: g.tracked, days: input.days, players };
    },
    heatmap: ({ input }) => {
      const g = data(input.uuid);
      const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
      const now = Date.now();
      const from = now - input.days * DAY;
      const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Amsterdam", weekday: "short", hour: "2-digit", hourCycle: "h23" });
      const DOW: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
      for (const s of g.sessions) {
        for (let t = Math.max(from, Math.floor(s.joinedAt.getTime() / H) * H); t < (s.leftAt?.getTime() ?? now); t += H) {
          const parts = fmt.formatToParts(new Date(t));
          const dow = DOW[parts.find((p) => p.type === "weekday")!.value] ?? 0;
          const hr = Number(parts.find((p) => p.type === "hour")!.value);
          cells[dow]![hr]! += 1;
        }
      }
      const weeks = input.days / 7;
      let max = 0;
      for (const row of cells) for (let h = 0; h < 24; h++) max = Math.max(max, (row[h] = Math.round((row[h]! / weeks) * 100) / 100));
      return { tracked: g.tracked, days: input.days, timezone: "Europe/Amsterdam", cells, max };
    },
    current: ({ input }) => {
      const g = data(input.uuid);
      return { tracked: g.tracked, sessions: g.sessions.filter((s) => !s.leftAt) };
    },
  };
}
