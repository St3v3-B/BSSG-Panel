/**
 * Opschonen van groeiende tabellen: het activiteitenlog (instelling `activity_retention_days`, 0 = altijd
 * bewaren), verlopen of inactieve sessies en oude node-join-codes. Draait vanuit de scheduler-tik, hooguit
 * eens per RETENTION_INTERVAL_MS, en verwijdert in kleine batches zodat er nooit een lange lock op een tabel staat.
 */
import { and, inArray, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { getDb, schema } from "./db";
import { sessionIdleMs } from "./session";
import { getActivityRetentionDays } from "./settings";
import { PLAYER_ACTIVITY_RETENTION_DAYS } from "@panel/api/player-activity";

const DAY_MS = 24 * 3600_000;
export const RETENTION_INTERVAL_MS = 3600_000;
/** Batchgrootte en pauze tussen batches; `maxBatches` begrenst één run (de rest volgt bij de volgende). */
export const retentionTuning = { batch: 2000, pauseMs: 25, maxBatches: 250 };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Verwijdert rijen die aan `where` voldoen in batches van `batch` (via de primaire sleutel). */
async function deleteBatched(table: PgTable, id: PgColumn, where: SQL | undefined): Promise<number> {
  const db = getDb();
  let total = 0;
  for (let i = 0; i < retentionTuning.maxBatches; i++) {
    const ids = db.select({ id }).from(table).where(where).limit(retentionTuning.batch);
    const gone = await db.delete(table).where(inArray(id, ids)).returning({ id });
    total += gone.length;
    if (gone.length < retentionTuning.batch) break;
    await pause(retentionTuning.pauseMs);
  }
  return total;
}

export interface RetentionResult {
  activity: number;
  sessions: number;
  joinCodes: number;
  /** Speleractiviteit: afgesloten sessies en servergebeurtenissen ouder dan PLAYER_ACTIVITY_RETENTION_DAYS. */
  playerSessions: number;
  serverEvents: number;
}

export async function runRetention(now = new Date()): Promise<RetentionResult> {
  const days = await getActivityRetentionDays();
  const activity = days > 0 ? await deleteBatched(schema.activityLog, schema.activityLog.id, lt(schema.activityLog.at, new Date(now.getTime() - days * DAY_MS))) : 0;

  const s = schema.sessions;
  const sessions = await deleteBatched(s, s.id, or(lt(s.expiresAt, now), lt(s.lastSeenAt, new Date(now.getTime() - sessionIdleMs()))));

  // Join-codes: verbruikt of verlopen en ouder dan een week; de nieuwste per node blijft (die toont de join-status).
  const j = schema.nodeJoinCodes;
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const latest = getDb().select({ id: sql<number>`max(${j.id})` }).from(j).groupBy(j.nodeId);
  const joinCodes = await deleteBatched(j, j.id, and(or(lt(j.expiresAt, weekAgo), lt(j.usedAt, weekAgo)), notInArray(j.id, latest)));

  const activityCutoff = new Date(now.getTime() - PLAYER_ACTIVITY_RETENTION_DAYS * DAY_MS);
  const playerSessions = await deleteBatched(schema.playerSessions, schema.playerSessions.id, lt(schema.playerSessions.leftAt, activityCutoff));
  const serverEvents = await deleteBatched(schema.serverEvents, schema.serverEvents.id, lt(schema.serverEvents.at, activityCutoff));

  return { activity, sessions, joinCodes, playerSessions, serverEvents };
}

let lastRun = 0;

/** Vanuit de scheduler-tik: hooguit eens per uur. */
export async function maybeRunRetention(now = new Date()): Promise<RetentionResult | null> {
  if (now.getTime() - lastRun < RETENTION_INTERVAL_MS) return null;
  lastRun = now.getTime();
  const r = await runRetention(now);
  if (r.activity || r.sessions || r.joinCodes || r.playerSessions || r.serverEvents)
    console.log(`[retention] removed ${r.activity} activity rows, ${r.sessions} sessions, ${r.joinCodes} join codes, ${r.playerSessions} player sessions, ${r.serverEvents} server events`);
  return r;
}
