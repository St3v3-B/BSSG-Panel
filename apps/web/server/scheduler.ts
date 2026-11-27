/**
 * Scheduler voor schema's. Bewust geen BullMQ: de planning staat al in Postgres
 * (`schedules.next_run_at`) en een taak is één korte daemonaanroep. Een in-process tikker
 * (elke 15 s) pakt wat vervallen is en claimt elke rij met een atomaire UPDATE
 * (`WHERE next_run_at = <oude waarde>`), zodat ook twee panelprocessen nooit dubbel
 * uitvoeren en een herstart niets kwijtraakt. Gemiste runs (panel was uit) draaien één keer.
 */
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { logActivity } from "./activity";
import { failStaleBackups, startBackup } from "./backups";
import { getDb, schema } from "./db";
import { call, daemonFor } from "./daemon";
import { nextRuns } from "./lib/cron";
import { monitorTick } from "./monitor";
import { fetchServerByUuid, type ServerBundle } from "./servers-data";

type ScheduleRow = typeof schema.schedules.$inferSelect;
export const TICK_MS = 15_000;

export function nextRunAfter(cron: string, from: Date = new Date()): Date | null {
  try {
    return nextRuns(cron, 1, from)[0] ?? null;
  } catch {
    return null;
  }
}

export const EXEC_TIMEOUT_S = 120;
export const OUTPUT_TAIL = 4000;

/** Voert de actie van een schema uit. Gooit bij een fout; geeft bij `exec` de uitvoer (staart) terug. */
export async function runAction(s: ScheduleRow, bundle: ServerBundle): Promise<string | null> {
  const node = daemonFor(bundle.node);
  switch (s.action) {
    case "restart":
      await call(() => node.power(bundle.server.uuid, "restart"));
      break;
    case "command":
      if (!s.payload) throw new Error("no command set");
      await call(() => node.sendCommands(bundle.server.uuid, [s.payload!]));
      break;
    case "backup":
      await startBackup(bundle, { name: `${s.name} ${new Date().toISOString().slice(0, 16).replace("T", " ")}`, includeDatabases: true, userId: null, scheduleId: s.id });
      break;
    case "exec": {
      if (!s.payload) throw new Error("no command set");
      const r = await call(() => node.exec(bundle.server.uuid, s.payload!, EXEC_TIMEOUT_S));
      const out = r.output.slice(-OUTPUT_TAIL);
      if (r.timed_out) throw new ExecFailed(`timeout after ${EXEC_TIMEOUT_S}s`, out);
      if (r.exit_code !== 0) throw new ExecFailed(`exit code ${r.exit_code}`, out);
      return out;
    }
  }
  return null;
}

/** Een exec die draaide maar mislukte: de uitvoer blijft bewaard. */
export class ExecFailed extends Error {
  constructor(message: string, readonly output: string) {
    super(message);
  }
}

/** Voert één schema uit en schrijft last_run/last_result. */
export async function execute(s: ScheduleRow, userId: number | null = null): Promise<string> {
  const db = getDb();
  let result = "ok";
  let output: string | null = null;
  try {
    const bundle = await fetchServerByUuid(await uuidOf(s.serverId));
    if (!bundle) throw new Error("server not found");
    output = await runAction(s, bundle);
  } catch (e) {
    result = `error: ${((e as Error).message ?? String(e)).slice(0, 300)}`;
    if (e instanceof ExecFailed) output = e.output;
  }
  await db.update(schema.schedules).set({ lastRunAt: new Date(), lastResult: result, lastOutput: s.action === "exec" ? output : null }).where(eq(schema.schedules.id, s.id));
  await logActivity({ action: "server.schedule.run", userId, serverId: s.serverId, metadata: { id: s.id, name: s.name, action: s.action, result } });
  return result;
}

async function uuidOf(serverId: number): Promise<string> {
  const [r] = await getDb().select({ uuid: schema.servers.uuid }).from(schema.servers).where(eq(schema.servers.id, serverId));
  if (!r) throw new Error("server not found");
  return r.uuid;
}

/** Eén tik: alles wat vervallen is claimen en uitvoeren. Geeft het aantal uitgevoerde schema's. */
export async function tick(now: Date = new Date()): Promise<number> {
  const db = getDb();
  const due = await db
    .select()
    .from(schema.schedules)
    .where(and(eq(schema.schedules.active, true), or(isNull(schema.schedules.nextRunAt), lte(schema.schedules.nextRunAt, now))))
    .limit(50);
  let ran = 0;
  for (const s of due) {
    const next = nextRunAfter(s.cron, now);
    const cond = s.nextRunAt ? eq(schema.schedules.nextRunAt, s.nextRunAt) : isNull(schema.schedules.nextRunAt);
    const [claimed] = await db.update(schema.schedules).set({ nextRunAt: next }).where(and(eq(schema.schedules.id, s.id), eq(schema.schedules.active, true), cond)).returning();
    if (!claimed) continue; // een ander proces was eerder
    if (!s.nextRunAt) continue; // zonder next_run alleen plannen, niet meteen draaien
    await execute(claimed);
    ran++;
  }
  await failStaleBackups(now).catch((e) => console.error("[scheduler] stale backups:", e));
  // Alleen in het echte proces: de tests roepen tick() zelf aan en willen geen netwerkverkeer.
  if (!process.env.VITEST) await monitorTick().catch((e) => console.error("[scheduler] monitor:", e));
  return ran;
}

let timer: ReturnType<typeof setInterval> | null = null;
let busy = false;

export function startScheduler(intervalMs = TICK_MS): void {
  if (timer) return;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    tick()
      .catch((e) => console.error("[scheduler] tick failed:", e))
      .finally(() => (busy = false));
  }, intervalMs);
  timer.unref();
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
