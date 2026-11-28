/**
 * Speleractiviteit per server (tab Activiteit, `playerActivity.*`).
 *
 * Bronnen:
 * - **Console** (primair): de daemon matcht join/leave met `player_events` uit de template en meldt ze, en het
 *   stoppen van de server (`stopped`, met reden crash/sleep/server_stop), via `POST /api/remote/servers/{uuid}/players`.
 *   Volgorde per server blijft behouden; dubbele events zijn no-ops (open sessie of zelfde `joined_at`).
 * - **Statusmeldingen**: overgangen naar/van draaien worden `server_events` (start, stop, sleep, wake). Crashes staan al
 *   in het activiteitenlog (`server.crashed`) en worden daar gelezen.
 * - **Vangnet** (`playerActivityTick`): sessies van servers die niet meer draaien worden na een korte wachttijd gesloten
 *   (gemiste `stopped`, bv. daemon offline); elke 5 min een server-list-ping op draaiende servers: spelers zonder
 *   sessie krijgen er een, en als de ping alle spelers noemt worden sessies van vertrokken spelers gesloten (`unknown`).
 *   Eenmalig krijgen bestaande servers de nieuwe spec (met `player_events`).
 */
import {
  PLAYER_ACTIVITY_RETENTION_DAYS,
  type ActivityHeatmap,
  type ActivityPlayers,
  type ActivityTimeline,
  type Implementation,
  type PlayerSession,
  type ServerEventKind,
  type ServerStatus,
  type SessionEndReason,
} from "@panel/api";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { call, daemonFor } from "./daemon";
import { getDb, schema } from "./db";
import { normUuid } from "./players";
import { fetchServers, requireServer, type ServerBundle } from "./servers-data";
import { templatePlayerEvents } from "./spec";

const S = schema.playerSessions;
const E = schema.serverEvents;
const MIN = 60_000;
const DAY = 24 * 3600_000;
export const TZ = "Europe/Amsterdam";
const RUNNING = new Set<string>(["starting", "online", "stopping"]);
const MAX_TIMELINE_SESSIONS = 2000;

/** Wachttijden van het vangnet (tests zetten ze kleiner). */
export const activityTiming = { closeGraceMs: 30_000, closeEveryMs: MIN, pingEveryMs: 5 * MIN, recentLeaveMs: 2 * MIN, crashWindowMs: MIN, specSyncEveryMs: 3600_000 };

// ---------- ingest (remote) ----------

export interface IncomingPlayerEvent {
  type: "join" | "leave" | "stopped";
  at: Date;
  name?: string;
  player_uuid?: string;
  reason?: "leave" | "server_stop" | "sleep" | "crash";
}

const lower = (n: string) => n.toLowerCase();
const validName = (n: string | undefined): n is string => !!n && n.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(n);

/** Daemontijd begrenzen: niet in de toekomst, niet ouder dan een dag. */
function clampAt(at: Date, now: Date): Date {
  const t = Math.min(Math.max(at.getTime(), now.getTime() - DAY), now.getTime());
  return new Date(t);
}

/** Verwerkt events van de daemon in volgorde. Idempotent. */
export async function ingestPlayerEvents(serverId: number, events: IncomingPlayerEvent[], now = new Date()): Promise<void> {
  const db = getDb();
  await db.transaction(async (tx) => {
    // Per server één verwerking tegelijk (de ping-reconcile kan meelopen).
    await tx.execute(sql`select pg_advisory_xact_lock(4242100, ${serverId}::int)`);
    for (const ev of events) {
      const at = clampAt(ev.at, now);
      if (ev.type === "stopped") {
        await tx
          .update(S)
          .set({ leftAt: sql`greatest(${S.joinedAt}, ${at.toISOString()}::timestamptz)`, endReason: ev.reason === "sleep" || ev.reason === "crash" ? ev.reason : "server_stop" })
          .where(and(eq(S.serverId, serverId), isNull(S.leftAt), lte(S.joinedAt, at)));
        continue;
      }
      if (!validName(ev.name)) continue;
      const [open] = await tx
        .select({ id: S.id, playerUuid: S.playerUuid })
        .from(S)
        .where(and(eq(S.serverId, serverId), isNull(S.leftAt), sql`lower(${S.name}) = ${lower(ev.name)}`))
        .orderBy(desc(S.joinedAt))
        .limit(1);
      if (ev.type === "join") {
        const uuid = normUuid(ev.player_uuid);
        if (open) {
          if (uuid && !open.playerUuid) await tx.update(S).set({ playerUuid: uuid }).where(eq(S.id, open.id));
          continue;
        }
        await tx.insert(S).values({ serverId, name: ev.name, playerUuid: uuid, joinedAt: at }).onConflictDoNothing();
      } else if (open) {
        const reason: SessionEndReason = ev.reason === "server_stop" || ev.reason === "sleep" || ev.reason === "crash" ? ev.reason : "leave";
        await tx.update(S).set({ leftAt: sql`greatest(${S.joinedAt}, ${at.toISOString()}::timestamptz)`, endReason: reason }).where(eq(S.id, open.id));
      }
    }
  });
}

/** Statusovergang → `server_events` (start/stop/sleep/wake). `prev` is de status vóór de melding. */
export async function recordStateTransition(serverId: number, prev: string, next: string, at = new Date()): Promise<ServerEventKind | null> {
  const was = RUNNING.has(prev);
  const is = RUNNING.has(next);
  let kind: ServerEventKind | null = null;
  if (!was && is) kind = prev === "sleeping" ? "wake" : "start";
  else if (was && !is) kind = next === "sleeping" ? "sleep" : "stop";
  if (kind) await getDb().insert(E).values({ serverId, kind, at });
  return kind;
}

// ---------- vangnet ----------

/** Sluit open sessies van servers die niet (meer) draaien. Geeft het aantal gesloten sessies. */
export async function closeStaleSessions(now = new Date()): Promise<number> {
  const db = getDb();
  const open = await db
    .select({ id: S.id, serverId: S.serverId, joinedAt: S.joinedAt, status: schema.servers.status })
    .from(S)
    .innerJoin(schema.servers, eq(schema.servers.id, S.serverId))
    .where(and(isNull(S.leftAt), sql`${schema.servers.status} not in ('starting', 'online', 'stopping')`))
    .limit(5000);
  let closed = 0;
  for (const s of open) {
    const [stop] = await db
      .select({ kind: E.kind, at: E.at })
      .from(E)
      .where(and(eq(E.serverId, s.serverId), inArray(E.kind, ["stop", "sleep"]), gte(E.at, s.joinedAt)))
      .orderBy(asc(E.at))
      .limit(1);
    let leftAt = now;
    let reason: SessionEndReason = "unknown";
    if (stop) {
      if (now.getTime() - stop.at.getTime() < activityTiming.closeGraceMs) continue; // daemon-melding kan nog komen
      leftAt = stop.at;
      reason = stop.kind === "sleep" ? "sleep" : (await crashNear(s.serverId, stop.at)) ? "crash" : "server_stop";
    } else if (s.status === "sleeping") {
      reason = "sleep";
    }
    const r = await db
      .update(S)
      .set({ leftAt: leftAt < s.joinedAt ? s.joinedAt : leftAt, endReason: reason })
      .where(and(eq(S.id, s.id), isNull(S.leftAt)))
      .returning({ id: S.id });
    closed += r.length;
  }
  return closed;
}

async function crashNear(serverId: number, at: Date): Promise<boolean> {
  const w = activityTiming.crashWindowMs;
  const [c] = await getDb()
    .select({ id: schema.activityLog.id })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.serverId, serverId), eq(schema.activityLog.action, "server.crashed"), gte(schema.activityLog.at, new Date(at.getTime() - w)), lte(schema.activityLog.at, new Date(at.getTime() + w))))
    .limit(1);
  return !!c;
}

export type PingResult = { online: number | null; sample?: Array<{ name: string; id: string }> } | null;

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Vergelijkt een server-list-ping met de open sessies. Opent sessies voor spelers zonder sessie (behalve wie net
 * vertrok); sluit sessies van wie er niet meer is, maar alleen als de ping alle spelers noemt.
 */
export async function reconcileWithPing(serverId: number, ping: PingResult, now = new Date()): Promise<{ opened: number; closed: number }> {
  if (!ping || ping.online === null) return { opened: 0, closed: 0 };
  const named = (ping.sample ?? []).filter((p) => validName(p.name) && p.id !== ZERO_UUID);
  const complete = ping.online === 0 || named.length >= ping.online;
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(4242100, ${serverId}::int)`);
    const open = await tx.select({ id: S.id, name: S.name }).from(S).where(and(eq(S.serverId, serverId), isNull(S.leftAt)));
    const openNames = new Set(open.map((o) => lower(o.name)));
    const seen = new Set(named.map((p) => lower(p.name)));
    let opened = 0;
    let closed = 0;
    for (const p of named) {
      if (openNames.has(lower(p.name))) continue;
      const [recent] = await tx
        .select({ id: S.id })
        .from(S)
        .where(and(eq(S.serverId, serverId), sql`lower(${S.name}) = ${lower(p.name)}`, gte(S.leftAt, new Date(now.getTime() - activityTiming.recentLeaveMs))))
        .limit(1);
      if (recent) continue;
      const r = await tx.insert(S).values({ serverId, name: p.name, playerUuid: normUuid(p.id), joinedAt: now }).onConflictDoNothing().returning({ id: S.id });
      opened += r.length;
    }
    if (complete) {
      const gone = open.filter((o) => !seen.has(lower(o.name))).map((o) => o.id);
      if (gone.length) closed = (await tx.update(S).set({ leftAt: now, endReason: "unknown" }).where(and(inArray(S.id, gone), isNull(S.leftAt))).returning({ id: S.id })).length;
    }
    return { opened, closed };
  });
}

const tracked = (b: ServerBundle) => b.server.type === "game" && templatePlayerEvents(b.template) !== null;

async function pingAll(): Promise<void> {
  const rows = (await fetchServers(and(eq(schema.servers.type, "game"), eq(schema.servers.status, "online")))).filter(tracked);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (i < rows.length) {
        const b = rows[i++]!;
        const ping = await daemonFor(b.node).players(b.server.uuid, 3000).catch(() => null);
        await reconcileWithPing(b.server.id, ping).catch((e) => console.error("[player-activity] reconcile:", e));
      }
    }),
  );
}

/** Versie van de spec-uitbreiding; hoger = bestaande servers krijgen opnieuw hun spec. */
export const PLAYER_EVENTS_SPEC_VERSION = 1;
const SPEC_SETTING = "player_events_spec_version";

/** Eenmalig: bestaande servers met speleractiviteit krijgen de spec met `player_events`. true = klaar. */
export async function syncPlayerEventSpecs(): Promise<boolean> {
  const db = getDb();
  const [row] = await db.select().from(schema.settings).where(eq(schema.settings.key, SPEC_SETTING));
  if (typeof row?.value === "number" && row.value >= PLAYER_EVENTS_SPEC_VERSION) return true;
  const { currentSpec } = await import("./routers/servers");
  const rows = (await fetchServers(eq(schema.servers.type, "game"))).filter((b) => tracked(b) && b.server.installedAt);
  let ok = true;
  for (const b of rows) {
    try {
      await call(async () => daemonFor(b.node).updateServer(b.server.uuid, await currentSpec(b, { skipInstall: true })));
    } catch {
      ok = false; // node onbereikbaar: volgende keer opnieuw
    }
  }
  if (ok) {
    await db
      .insert(schema.settings)
      .values({ key: SPEC_SETTING, value: PLAYER_EVENTS_SPEC_VERSION })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: PLAYER_EVENTS_SPEC_VERSION, updatedAt: new Date() } });
  }
  return ok;
}

const last = { close: 0, ping: 0, spec: 0, specDone: false };
let busy = false;

/** Vanuit de scheduler-tik. */
export async function playerActivityTick(now = new Date()): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const t = now.getTime();
    if (t - last.close >= activityTiming.closeEveryMs) {
      last.close = t;
      await closeStaleSessions(now);
    }
    if (t - last.ping >= activityTiming.pingEveryMs) {
      last.ping = t;
      await pingAll();
    }
    if (!last.specDone && t - last.spec >= activityTiming.specSyncEveryMs) {
      last.spec = t;
      last.specDone = await syncPlayerEventSpecs();
    }
  } finally {
    busy = false;
  }
}

// ---------- aggregaties ----------

type SessionRow = typeof S.$inferSelect;
const toSession = (r: SessionRow): PlayerSession => ({
  id: r.id,
  name: r.name,
  uuid: r.playerUuid,
  joinedAt: r.joinedAt,
  leftAt: r.leftAt,
  endReason: (r.endReason as SessionEndReason | null) ?? null,
});

export async function timeline(serverId: number, range: "day" | "week", end: Date, now = new Date()): Promise<Omit<ActivityTimeline, "tracked">> {
  const to = end > now ? now : end;
  const from = new Date(to.getTime() - (range === "day" ? DAY : 7 * DAY));
  const db = getDb();
  const rows = await db
    .select()
    .from(S)
    .where(and(eq(S.serverId, serverId), lt(S.joinedAt, to), or(isNull(S.leftAt), gte(S.leftAt, from))))
    .orderBy(desc(S.joinedAt))
    .limit(MAX_TIMELINE_SESSIONS + 1);
  const truncated = rows.length > MAX_TIMELINE_SESSIONS;
  const sessions = rows.slice(0, MAX_TIMELINE_SESSIONS).reverse().map(toSession);
  const states = await db.select({ at: E.at, kind: E.kind }).from(E).where(and(eq(E.serverId, serverId), gte(E.at, from), lte(E.at, to))).orderBy(asc(E.at)).limit(5000);
  const crashes = await db
    .select({ at: schema.activityLog.at })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.serverId, serverId), eq(schema.activityLog.action, "server.crashed"), gte(schema.activityLog.at, from), lte(schema.activityLog.at, to)))
    .limit(2000);
  // Een crash is ook een stop: de stop-markering rond een crash weglaten.
  const nearCrash = (at: Date) => crashes.some((c) => Math.abs(c.at.getTime() - at.getTime()) <= activityTiming.crashWindowMs);
  const events = [
    ...states.filter((e) => !(e.kind === "stop" && nearCrash(e.at))).map((e) => ({ at: e.at, kind: e.kind as ServerEventKind })),
    ...crashes.map((c) => ({ at: c.at, kind: "crash" as const })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
  return { range, from, to, sessions, events, truncated };
}

export async function playersOverview(serverId: number, days: number, now = new Date()): Promise<ActivityPlayers["players"]> {
  const from = new Date(now.getTime() - days * DAY);
  const nowIso = now.toISOString();
  const fromIso = from.toISOString();
  const rows = await getDb().execute(sql`
    SELECT
      (array_agg(name ORDER BY joined_at DESC))[1] AS name,
      (array_agg(player_uuid::text ORDER BY joined_at DESC) FILTER (WHERE player_uuid IS NOT NULL))[1] AS uuid,
      count(*)::int AS sessions,
      coalesce(sum(extract(epoch FROM least(coalesce(left_at, ${nowIso}::timestamptz), ${nowIso}::timestamptz) - greatest(joined_at, ${fromIso}::timestamptz))), 0)::bigint AS total,
      min(joined_at) AS first_seen,
      max(coalesce(left_at, ${nowIso}::timestamptz)) AS last_seen,
      bool_or(left_at IS NULL) AS online
    FROM player_sessions
    WHERE server_id = ${serverId}::int AND joined_at < ${nowIso}::timestamptz AND (left_at IS NULL OR left_at >= ${fromIso}::timestamptz)
    GROUP BY lower(name)
    ORDER BY bool_or(left_at IS NULL) DESC, max(coalesce(left_at, ${nowIso}::timestamptz)) DESC
    LIMIT 500`);
  return (rows as unknown as Array<{ name: string; uuid: string | null; sessions: number; total: string | number; first_seen: string | Date; last_seen: string | Date; online: boolean }>).map((r) => ({
    name: r.name,
    uuid: r.uuid,
    sessions: Number(r.sessions),
    totalSeconds: Math.max(0, Math.round(Number(r.total))),
    firstSeen: new Date(r.first_seen),
    lastSeen: new Date(r.last_seen),
    online: !!r.online,
  }));
}

/** Gemiddeld aantal spelers tegelijk per weekdag (ma=0) × uur, over volle uren in de laatste `days` dagen. */
export async function heatmap(serverId: number, days: number, now = new Date()): Promise<Omit<ActivityHeatmap, "tracked">> {
  const to = new Date(Math.floor(now.getTime() / 3600_000) * 3600_000);
  const from = new Date(to.getTime() - days * DAY);
  const toIso = to.toISOString();
  const fromIso = from.toISOString();
  const rows = await getDb().execute(sql`
    WITH hours AS (
      SELECT h FROM generate_series(${fromIso}::timestamptz, ${toIso}::timestamptz - interval '1 hour', interval '1 hour') AS h
    ), per_hour AS (
      SELECT hours.h, coalesce(sum(extract(epoch FROM least(coalesce(s.left_at, ${toIso}::timestamptz), hours.h + interval '1 hour') - greatest(s.joined_at, hours.h))) FILTER (WHERE s.id IS NOT NULL), 0) / 3600.0 AS players
      FROM hours
      LEFT JOIN player_sessions s
        ON s.server_id = ${serverId}::int AND s.joined_at < hours.h + interval '1 hour' AND coalesce(s.left_at, ${toIso}::timestamptz) > hours.h
      GROUP BY hours.h
    )
    SELECT (extract(isodow FROM h AT TIME ZONE ${TZ})::int - 1) AS dow, extract(hour FROM h AT TIME ZONE ${TZ})::int AS hr, avg(players)::float8 AS avg
    FROM per_hour GROUP BY 1, 2`);
  const cells = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let max = 0;
  for (const r of rows as unknown as Array<{ dow: number; hr: number; avg: number }>) {
    const v = Math.round(Number(r.avg) * 100) / 100;
    cells[Number(r.dow)]![Number(r.hr)] = v;
    if (v > max) max = v;
  }
  return { days, timezone: TZ, cells, max };
}

export async function currentSessions(serverId: number): Promise<PlayerSession[]> {
  const rows = await getDb().select().from(S).where(and(eq(S.serverId, serverId), isNull(S.leftAt))).orderBy(asc(S.joinedAt)).limit(1000);
  return rows.map(toSession);
}

// ---------- procedures ----------

async function access(ctx: Parameters<typeof requireServer>[0], uuid: string) {
  const a = await requireServer(ctx, uuid, "players.read");
  return { id: a.bundle.server.id, tracked: tracked(a.bundle) };
}

export const playerActivity: Implementation["playerActivity"] = {
  timeline: async ({ input, ctx }) => {
    const a = await access(ctx, input.uuid);
    const t = await timeline(a.id, input.range, input.end ?? new Date());
    return a.tracked ? { tracked: true, ...t } : { tracked: false, ...t, sessions: [], events: [], truncated: false };
  },
  players: async ({ input, ctx }) => {
    const a = await access(ctx, input.uuid);
    return { tracked: a.tracked, days: input.days, players: a.tracked ? await playersOverview(a.id, input.days) : [] };
  },
  heatmap: async ({ input, ctx }) => {
    const a = await access(ctx, input.uuid);
    if (!a.tracked) return { tracked: false, days: input.days, timezone: TZ, cells: Array.from({ length: 7 }, () => Array(24).fill(0) as number[]), max: 0 };
    return { tracked: true, ...(await heatmap(a.id, input.days)) };
  },
  current: async ({ input, ctx }) => {
    const a = await access(ctx, input.uuid);
    return { tracked: a.tracked, sessions: a.tracked ? await currentSessions(a.id) : [] };
  },
};

/** Statussen waarmee een server niet draait (voor tests). */
export const isRunningStatus = (s: ServerStatus | string) => RUNNING.has(s);
