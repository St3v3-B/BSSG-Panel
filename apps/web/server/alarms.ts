/**
 * Verbruiksalarmen: melding als CPU of RAM gedurende N minuten boven X% van de limiet zit, of de disk boven Z%.
 *
 * - Evaluatie in de panel-scheduler (eens per minuut, direct na het verzamelen van de stats) op de bestaande
 *   1-minuutmetingen in `server_stats`: geen extra daemon-aanroepen.
 * - Hysterese: een actief alarm gaat pas uit als de waarde onder de drempel min HYSTERESIS zakt (CPU/RAM: alle
 *   metingen van de laatste min(N, 5) minuten), zodat schommelen rond de drempel geen reeks meldingen geeft.
 * - Cooldown (admin-instelling, standaard 60 min): na een melding komt er voor die server en meetwaarde geen
 *   nieuwe "te hoog"-melding binnen de cooldown. Een "weer normaal"-melding gaat alleen als de bijbehorende
 *   "te hoog" ook verstuurd is.
 * - Toestand in `server_alarm_state` (overleeft herstarts); overgangen worden geclaimd met een voorwaardelijke
 *   UPDATE, dus twee panelprocessen melden nooit dubbel.
 * - Crash/offline: de bestaande `server_crashed`-melding (daemon-event) is het offline-alarm; `notify_offline`
 *   uit haalt de eigenaar (en de serverwebhook) daaruit weg. Er komt geen tweede melding bij.
 */
import type { ActiveAlarm, AlarmConfig, AlarmDefaults, AlarmMetric, Implementation, ServerAlarms } from "@panel/api";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { logActivity } from "./activity";
import { getDb, schema } from "./db";
import { notify, serverHookOf, type Target } from "./notify";
import { requireServer, userPublic } from "./servers-data";

export const DEFAULT_ALARMS: AlarmDefaults = { enabled: false, cpuPct: 90, ramPct: 90, durationMinutes: 10, diskPct: 90, cooldownMinutes: 60 };
export const HYSTERESIS: Record<AlarmMetric, number> = { cpu: 10, ram: 10, disk: 5 };
const KEY = "alarm_defaults";
const MIB = 1024 * 1024;
const MINUTE_MS = 60_000;
/** Deel van het venster dat mag ontbreken (een gemiste meting door een trage node blokkeert het alarm niet). */
const GAP_TOLERANCE = 0.2;

type StateRow = typeof schema.serverAlarmState.$inferSelect;
type OwnRow = typeof schema.serverAlarms.$inferSelect;

const int = (v: unknown, min: number, max: number, d: number | null): number | null => (typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : d);

export async function getAlarmDefaults(): Promise<AlarmDefaults> {
  const [r] = await getDb().select().from(schema.settings).where(eq(schema.settings.key, KEY));
  const v = (r?.value ?? {}) as Record<string, unknown>;
  const pct = (k: "cpuPct" | "ramPct" | "diskPct") => (v[k] === null ? null : int(v[k], 10, 100, DEFAULT_ALARMS[k]));
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULT_ALARMS.enabled,
    cpuPct: pct("cpuPct"),
    ramPct: pct("ramPct"),
    diskPct: pct("diskPct"),
    durationMinutes: int(v.durationMinutes, 1, 120, DEFAULT_ALARMS.durationMinutes)!,
    cooldownMinutes: int(v.cooldownMinutes, 5, 1440, DEFAULT_ALARMS.cooldownMinutes)!,
  };
}

const ownConfig = (o: OwnRow): AlarmConfig => ({ enabled: o.enabled, cpuPct: o.cpuPct, ramPct: o.ramPct, durationMinutes: o.durationMinutes, diskPct: o.diskPct });
const baseOf = ({ cooldownMinutes: _c, ...rest }: AlarmDefaults): AlarmConfig => rest;

/** Wat geldt voor een server: eigen instelling, anders de standaard. */
export function effectiveConfig(own: OwnRow | undefined, d: AlarmDefaults): AlarmConfig {
  return own ? ownConfig(own) : baseOf(d);
}

// ---------- evalueren ----------

interface Sample { t: number; cpu: number; mem: number; disk: number }

export interface EvalResult { triggered: number; resolved: number; notified: number }

/** Eén ronde. `now` instelbaar (tests met een nep-klok). */
export async function evaluateAlarms(now = new Date()): Promise<EvalResult> {
  const db = getDb();
  const out: EvalResult = { triggered: 0, resolved: 0, notified: 0 };
  const defaults = await getAlarmDefaults();
  const rows = await db
    .select({ s: schema.servers, a: schema.serverAlarms })
    .from(schema.servers)
    .leftJoin(schema.serverAlarms, eq(schema.serverAlarms.serverId, schema.servers.id));
  const states = await db.select().from(schema.serverAlarmState);
  const stateOf = new Map(states.map((x) => [`${x.serverId}:${x.metric}`, x]));
  const configs = new Map(rows.map((r) => [r.s.id, effectiveConfig(r.a ?? undefined, defaults)]));

  // Uit gezet of drempel weg: toestand stil opruimen.
  const stale = states.filter((x) => {
    const c = configs.get(x.serverId);
    return !c || !c.enabled || thresholdOf(c, x.metric) === null;
  });
  if (stale.length) {
    for (const x of stale) await db.delete(schema.serverAlarmState).where(and(eq(schema.serverAlarmState.serverId, x.serverId), eq(schema.serverAlarmState.metric, x.metric)));
  }

  const watched = rows.filter((r) => configs.get(r.s.id)!.enabled);
  if (!watched.length) return out;
  const maxMin = Math.max(10, ...watched.map((r) => configs.get(r.s.id)!.durationMinutes));
  const since = new Date(Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS - maxMin * MINUTE_MS);
  const stats = await db
    .select({ serverId: schema.serverStats.serverId, bucket: schema.serverStats.bucket, cpu: schema.serverStats.cpuPct, mem: schema.serverStats.memoryBytes, disk: schema.serverStats.diskBytes })
    .from(schema.serverStats)
    .where(and(inArray(schema.serverStats.serverId, watched.map((r) => r.s.id)), eq(schema.serverStats.resolution, 60), gte(schema.serverStats.bucket, since), sql`${schema.serverStats.bucket} <= ${now.toISOString()}::timestamptz`));
  const byServer = new Map<number, Sample[]>();
  for (const s of stats) {
    const list = byServer.get(s.serverId) ?? [];
    list.push({ t: s.bucket.getTime(), cpu: s.cpu, mem: s.mem, disk: s.disk });
    byServer.set(s.serverId, list);
  }

  for (const { s } of watched) {
    const c = configs.get(s.id)!;
    const samples = (byServer.get(s.id) ?? []).sort((a, b) => a.t - b.t);
    for (const metric of ["cpu", "ram", "disk"] as const) {
      const threshold = thresholdOf(c, metric);
      if (threshold === null) continue;
      const pct = pctFn(metric, s);
      if (!pct) continue; // geen limiet (0 = onbeperkt): niets om tegen te meten
      const state = stateOf.get(`${s.id}:${metric}`);
      const decision = decide(metric, threshold, c.durationMinutes, samples.map((x) => ({ t: x.t, v: pct(x) })), now, !!state?.active);
      if (decision.kind === "none") continue;
      if (decision.kind === "update") {
        if (state?.active) await db.update(schema.serverAlarmState).set({ value: decision.value, updatedAt: now }).where(and(eq(schema.serverAlarmState.serverId, s.id), eq(schema.serverAlarmState.metric, metric)));
        continue;
      }
      const target: Target = { server: { uuid: s.uuid, name: s.name }, hooks: [serverHookOf(s)].filter((h): h is string => !!h), admin: false, users: [s.ownerId] };
      if (decision.kind === "trigger") {
        await db.insert(schema.serverAlarmState).values({ serverId: s.id, metric, active: false }).onConflictDoNothing();
        const [claimed] = await db
          .update(schema.serverAlarmState)
          .set({ active: true, since: decision.since, value: decision.value, threshold, updatedAt: now })
          .where(and(eq(schema.serverAlarmState.serverId, s.id), eq(schema.serverAlarmState.metric, metric), eq(schema.serverAlarmState.active, false)))
          .returning();
        if (!claimed) continue;
        out.triggered++;
        const cooling = claimed.lastNotifiedAt && now.getTime() - claimed.lastNotifiedAt.getTime() < defaults.cooldownMinutes * MINUTE_MS;
        if (!cooling) {
          await db.update(schema.serverAlarmState).set({ lastNotifiedAt: now }).where(and(eq(schema.serverAlarmState.serverId, s.id), eq(schema.serverAlarmState.metric, metric)));
          await notify({ kind: "usage_alarm", metric, state: "triggered", valuePct: decision.value, thresholdPct: threshold, durationMinutes: c.durationMinutes }, target);
          out.notified++;
        }
        await logActivity({ action: "server.alarm.triggered", serverId: s.id, metadata: { metric, valuePct: Math.round(decision.value * 10) / 10, thresholdPct: threshold, notified: !cooling } });
      } else {
        const [claimed] = await db
          .update(schema.serverAlarmState)
          .set({ active: false, value: decision.value, updatedAt: now })
          .where(and(eq(schema.serverAlarmState.serverId, s.id), eq(schema.serverAlarmState.metric, metric), eq(schema.serverAlarmState.active, true)))
          .returning();
        if (!claimed) continue;
        out.resolved++;
        // Alleen "weer normaal" als de bijbehorende "te hoog" verstuurd is, en niet als de server gewoon stopte.
        const announced = !!claimed.lastNotifiedAt && !!state?.since && claimed.lastNotifiedAt.getTime() >= state.since.getTime();
        if (announced && decision.quiet !== true) {
          await notify({ kind: "usage_alarm", metric, state: "resolved", valuePct: decision.value, thresholdPct: threshold, durationMinutes: c.durationMinutes }, target);
          out.notified++;
        }
      }
    }
  }
  return out;
}

const thresholdOf = (c: AlarmConfig, m: AlarmMetric) => (m === "cpu" ? c.cpuPct : m === "ram" ? c.ramPct : c.diskPct);

function pctFn(m: AlarmMetric, s: typeof schema.servers.$inferSelect): ((x: Sample) => number) | null {
  if (m === "cpu") return s.cpuPct > 0 ? (x) => (x.cpu / s.cpuPct) * 100 : null;
  if (m === "ram") return s.ramMb > 0 ? (x) => (x.mem / (s.ramMb * MIB)) * 100 : null;
  return s.diskMb > 0 ? (x) => (x.disk / (s.diskMb * MIB)) * 100 : null;
}

type Decision =
  | { kind: "none" }
  | { kind: "update"; value: number }
  | { kind: "trigger"; value: number; since: Date }
  | { kind: "resolve"; value: number; quiet?: boolean };

/** Puur: beslist op basis van de metingen (t = begin van de minuut, v = procent van de limiet). */
export function decide(metric: AlarmMetric, threshold: number, durationMinutes: number, points: Array<{ t: number; v: number }>, now: Date, active: boolean): Decision {
  const nowMinute = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  const within = (minutes: number) => points.filter((p) => p.t > nowMinute - minutes * MINUTE_MS && p.t <= nowMinute);
  const lower = threshold - HYSTERESIS[metric];
  if (metric === "disk") {
    const recent = within(10);
    const last = recent[recent.length - 1];
    if (!last) return { kind: "none" }; // geen meting: toestand houden
    if (!active) return last.v > threshold ? { kind: "trigger", value: last.v, since: new Date(last.t) } : { kind: "none" };
    return last.v < lower ? { kind: "resolve", value: last.v } : { kind: "update", value: last.v };
  }
  const win = within(durationMinutes);
  const latest = win[win.length - 1];
  if (!active) {
    const need = Math.max(1, Math.ceil(durationMinutes * (1 - GAP_TOLERANCE)));
    // Metingen zijn per minuut uniek, dus `need` metingen beslaan ook (bijna) het hele venster.
    if (win.length < need || !win.every((p) => p.v > threshold)) return { kind: "none" };
    return { kind: "trigger", value: latest!.v, since: new Date(win[0]!.t) };
  }
  const calm = within(Math.min(durationMinutes, 5));
  if (!calm.length) {
    // Geen metingen meer: de server draait niet (meer). Stil uit, zonder "weer normaal".
    return within(10).length ? { kind: "none" } : { kind: "resolve", value: 0, quiet: true };
  }
  if (calm.every((p) => p.v < lower)) return { kind: "resolve", value: calm[calm.length - 1]!.v };
  return { kind: "update", value: calm[calm.length - 1]!.v };
}

let lastRun = 0;
let running = false;
/** Vanuit de scheduler-tik, na statsTick: hooguit eens per minuut. */
export async function alarmsTick(now = Date.now()): Promise<void> {
  if (running || now - lastRun < MINUTE_MS - 5_000) return;
  running = true;
  lastRun = now;
  try {
    await evaluateAlarms(new Date(now));
  } catch (e) {
    console.error("[alarms]", e);
  } finally {
    running = false;
  }
}

// ---------- crashmelding (offline-alarm) ----------

/** Ontvangers voor `server_crashed`: zonder eigenaar en serverwebhook als de eigenaar het offline-alarm uitzette. */
export async function crashTarget(t: Target, serverId: number): Promise<Target> {
  const [a] = await getDb().select({ n: schema.serverAlarms.notifyOffline }).from(schema.serverAlarms).where(eq(schema.serverAlarms.serverId, serverId));
  if (!a || a.n) return t;
  return { ...t, hooks: [], users: [] };
}

// ---------- procedures ----------

async function activeFor(serverIds: number[]): Promise<StateRow[]> {
  if (!serverIds.length) return [];
  return getDb().select().from(schema.serverAlarmState).where(and(inArray(schema.serverAlarmState.serverId, serverIds), eq(schema.serverAlarmState.active, true)));
}

async function serverAlarms(serverId: number): Promise<ServerAlarms> {
  const defaults = await getAlarmDefaults();
  const [own] = await getDb().select().from(schema.serverAlarms).where(eq(schema.serverAlarms.serverId, serverId));
  const config = effectiveConfig(own, defaults);
  return {
    useDefaults: !own,
    config,
    defaults,
    notifyOffline: own?.notifyOffline ?? true,
    active: (await activeFor([serverId])).map((x) => ({ metric: x.metric, valuePct: x.value ?? 0, thresholdPct: x.threshold ?? 0, since: x.since ?? x.updatedAt })),
  };
}

export const alarmProcedures: Pick<Implementation["servers"], "alarms" | "updateAlarms"> = {
  alarms: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner");
    return serverAlarms(a.bundle.server.id);
  },
  updateAlarms: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const db = getDb();
    const id = a.bundle.server.id;
    if (input.config === null && input.notifyOffline) {
      await db.delete(schema.serverAlarms).where(eq(schema.serverAlarms.serverId, id));
    } else {
      // Geen eigen drempels maar wel offline uit: een rij die de standaard van de admin volgt kan niet, dus de huidige standaard vastleggen.
      const c = input.config ?? baseOf(await getAlarmDefaults());
      const v = { enabled: c.enabled, cpuPct: c.cpuPct, ramPct: c.ramPct, durationMinutes: c.durationMinutes, diskPct: c.diskPct, notifyOffline: input.notifyOffline, updatedAt: new Date() };
      await db.insert(schema.serverAlarms).values({ serverId: id, ...v }).onConflictDoUpdate({ target: schema.serverAlarms.serverId, set: v });
    }
    await logActivity({ action: "server.alarms.update", userId: ctx.session!.userId, serverId: id, metadata: { config: input.config, notifyOffline: input.notifyOffline }, ip: ctx.ip, ctx });
    return serverAlarms(id);
  },
};

export const alarmAdmin: Implementation["admin"]["alarms"] = {
  defaults: () => getAlarmDefaults(),
  setDefaults: async ({ input, ctx }) => {
    const prev = await getAlarmDefaults();
    await getDb()
      .insert(schema.settings)
      .values({ key: KEY, value: input })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: input, updatedAt: new Date() } });
    await logActivity({ action: "admin.alarms.defaults", userId: ctx.session!.userId, metadata: { from: prev, to: input }, ip: ctx.ip, ctx });
    return getAlarmDefaults();
  },
  active: async (): Promise<ActiveAlarm[]> => {
    const rows = await getDb()
      .select({ st: schema.serverAlarmState, s: schema.servers, u: schema.users })
      .from(schema.serverAlarmState)
      .innerJoin(schema.servers, eq(schema.servers.id, schema.serverAlarmState.serverId))
      .innerJoin(schema.users, eq(schema.users.id, schema.servers.ownerId))
      .where(eq(schema.serverAlarmState.active, true))
      .orderBy(schema.serverAlarmState.since)
      .limit(200);
    return rows.map((r) => ({ server: { uuid: r.s.uuid, name: r.s.name }, owner: userPublic(r.u), metric: r.st.metric, valuePct: r.st.value ?? 0, thresholdPct: r.st.threshold ?? 0, since: r.st.since ?? r.st.updatedAt }));
  },
};
