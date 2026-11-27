/**
 * Verbruiksgeschiedenis voor de grafieken.
 *
 * - **Verzamelen** (`collectStats`, elke minuut vanuit de scheduler): per node één aanroep
 *   `GET /api/stats` (alle draaiende servers). Oudere daemons zonder dat pad (404): per draaiende
 *   server `GET /api/servers/{uuid}/stats`, met beperkte parallelliteit, voor de servers die de
 *   node-monitor als draaiend kent. Alle nodes tegelijk; één INSERT voor alles. Een node die niet
 *   antwoordt levert niets op: een gat in de grafiek, geen fout.
 * - **Samenvatten** (`rollup`): 1 min → 15 min → 1 uur, gewogen naar het aantal metingen. Elke tik
 *   rekent de recente (ook nog lopende) buckets opnieuw uit, zodat 7d/30d meteen actueel zijn.
 * - **Opschonen** (`prune`): 1 min na 24 u, 15 min na 7 d, 1 uur na 30 d (plus een kleine marge).
 *
 * Twee panelprocessen tegelijk is onschuldig: de primaire sleutel (server, resolutie, bucket) met
 * ON CONFLICT DO NOTHING houdt per minuut één meting.
 */
import type { DaemonServerStats, StatsHistory, StatsPoint, StatsRange, StatsSparkline } from "@panel/api";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { DaemonHttpError, daemonFor } from "./daemon";
import { getDb, schema } from "./db";
import { getNodeLive } from "./node-cache";

type NodeRow = typeof schema.nodes.$inferSelect;

export const MINUTE = 60;
export const QUARTER = 900;
export const HOUR = 3600;
const H = 3600_000;
const D = 24 * H;

/** Hoe lang elke resolutie bewaard blijft (ms). */
export const RETENTION_MS: Record<number, number> = { [MINUTE]: 25 * H, [QUARTER]: 7 * D + H, [HOUR]: 30 * D + H };

/** Bron en stapgrootte per periode. */
export const RANGES: Record<StatsRange, { spanS: number; stepS: number; resolution: number }> = {
  "1h": { spanS: 3600, stepS: 60, resolution: MINUTE },
  "24h": { spanS: 86_400, stepS: 300, resolution: MINUTE },
  "7d": { spanS: 7 * 86_400, stepS: 1800, resolution: QUARTER },
  "30d": { spanS: 30 * 86_400, stepS: 7200, resolution: HOUR },
};

export const COLLECT_EVERY_MS = 60_000;
const PRUNE_EVERY_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const FALLBACK_CONCURRENCY = 8;
/** Een node zonder `/api/stats` wordt zo lang per server gevraagd voordat we het opnieuw proberen. */
const NO_BATCH_RECHECK_MS = H;
const RUNNING = new Set(["online", "starting", "stopping"]);

const floorTo = (ms: number, stepS: number) => Math.floor(ms / (stepS * 1000)) * stepS * 1000;

// ---------- verzamelen ----------

export type NodeStatsFetcher = (node: NodeRow) => Promise<DaemonServerStats[]>;

const noBatchUntil = new Map<number, number>();

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++]!;
        out.push(await fn(item));
      }
    }),
  );
  return out;
}

/** Standaard: batch-endpoint, met terugval per server voor oudere daemons. */
export const defaultFetcher: NodeStatsFetcher = async (node) => {
  const client = daemonFor(node);
  if ((noBatchUntil.get(node.id) ?? 0) <= Date.now()) {
    try {
      return (await client.allStats(FETCH_TIMEOUT_MS)).servers;
    } catch (e) {
      if (!(e instanceof DaemonHttpError && e.status === 404)) throw e;
      noBatchUntil.set(node.id, Date.now() + NO_BATCH_RECHECK_MS);
    }
  }
  const live = await getNodeLive(node.id);
  if (!live?.online) return [];
  const uuids = Object.entries(live.servers).filter(([, s]) => RUNNING.has(s.state)).map(([u]) => u);
  const got = await mapLimit(uuids, FALLBACK_CONCURRENCY, async (uuid) => {
    try {
      const st = await client.stats(uuid, FETCH_TIMEOUT_MS);
      return st.uptime_ms > 0 ? { uuid, ...st } : null;
    } catch {
      return null;
    }
  });
  return got.filter((x): x is DaemonServerStats => x !== null);
};

interface Counter { rx: number; tx: number; uptimeMs: number; at: number }
const counters = new Map<number, Counter>();
let lastCollect = 0;
let lastPrune = 0;

/** Alleen tests. */
export function resetStatsHistory(): void {
  counters.clear();
  noBatchUntil.clear();
  lastCollect = 0;
  lastPrune = 0;
}

/** Bytes/s sinds de vorige meting; null bij geen vorige, een herstart (teller terug) of een te groot gat. */
function rate(prev: Counter | undefined, cur: Counter, field: "rx" | "tx"): number | null {
  if (!prev) return null;
  const dt = (cur.at - prev.at) / 1000;
  if (dt <= 0 || dt > 5 * 60) return null;
  if (cur.uptimeMs < prev.uptimeMs || cur[field] < prev[field]) return null;
  return (cur[field] - prev[field]) / dt;
}

/**
 * Eén meetronde: alle nodes parallel, één INSERT. Geeft het aantal opgeslagen metingen.
 * Rolt daarna samen en schoont (hooguit eens per 10 min) op.
 */
export async function collectStats(now = new Date(), fetcher: NodeStatsFetcher = defaultFetcher): Promise<number> {
  const db = getDb();
  const [nodes, servers] = await Promise.all([
    db.select().from(schema.nodes),
    db.select({ id: schema.servers.id, uuid: schema.servers.uuid, nodeId: schema.servers.nodeId }).from(schema.servers),
  ]);
  const byUuid = new Map(servers.map((s) => [s.uuid, s]));
  const perNode = await Promise.all(
    nodes.map(async (n) => {
      try {
        return { node: n, stats: await fetcher(n) };
      } catch {
        return { node: n, stats: [] as DaemonServerStats[] }; // onbereikbaar: gat in de grafiek
      }
    }),
  );
  const bucket = new Date(floorTo(now.getTime(), MINUTE));
  const rows: (typeof schema.serverStats.$inferInsert)[] = [];
  for (const { node, stats } of perNode) {
    for (const st of stats) {
      const srv = byUuid.get(st.uuid);
      if (!srv || srv.nodeId !== node.id) continue; // onbekend of (nog) op een andere node
      const cur: Counter = { rx: st.network_rx_bytes, tx: st.network_tx_bytes, uptimeMs: st.uptime_ms, at: now.getTime() };
      const prev = counters.get(srv.id);
      counters.set(srv.id, cur);
      const cpu = Math.max(0, Number.isFinite(st.cpu_pct) ? st.cpu_pct : 0);
      rows.push({
        serverId: srv.id,
        resolution: MINUTE,
        bucket,
        samples: 1,
        cpuPct: cpu,
        cpuMaxPct: cpu,
        memoryBytes: Math.max(0, Math.round(st.memory_bytes)),
        memoryMaxBytes: Math.max(0, Math.round(st.memory_bytes)),
        diskBytes: Math.max(0, Math.round(st.disk_bytes)),
        rxBytesPerSec: rate(prev, cur, "rx"),
        txBytesPerSec: rate(prev, cur, "tx"),
      });
    }
  }
  // Tellers van servers die niet meer draaien vergeten (anders groeit de map en klopt de eerste rate niet).
  const seen = new Set(rows.map((r) => r.serverId));
  for (const id of counters.keys()) if (!seen.has(id)) counters.delete(id);
  if (rows.length) await db.insert(schema.serverStats).values(rows).onConflictDoNothing();
  await rollup(now);
  if (now.getTime() - lastPrune >= PRUNE_EVERY_MS) {
    lastPrune = now.getTime();
    await prune(now);
  }
  return rows.length;
}

// ---------- samenvatten en opschonen ----------

/** Vat `from`-rijen samen tot `to`-buckets vanaf `since` (overschrijft bestaande buckets). */
async function rollupLevel(from: number, to: number, since: Date): Promise<void> {
  await getDb().execute(sql`
    INSERT INTO server_stats (server_id, resolution, bucket, samples, cpu_pct, cpu_max_pct, memory_bytes, memory_max_bytes, disk_bytes, rx_bytes_per_sec, tx_bytes_per_sec)
    SELECT server_id, ${to}::int, b, sum(samples)::int,
      (sum(cpu_pct::float8 * samples) / sum(samples))::real,
      max(cpu_max_pct),
      round(sum(memory_bytes::float8 * samples) / sum(samples))::bigint,
      max(memory_max_bytes),
      (array_agg(disk_bytes ORDER BY bucket DESC))[1],
      (sum(rx_bytes_per_sec::float8 * samples) / nullif(sum(samples) FILTER (WHERE rx_bytes_per_sec IS NOT NULL), 0))::real,
      (sum(tx_bytes_per_sec::float8 * samples) / nullif(sum(samples) FILTER (WHERE tx_bytes_per_sec IS NOT NULL), 0))::real
    FROM (
      SELECT *, date_bin(make_interval(secs => ${to}::int), bucket, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS b
      FROM server_stats
      WHERE resolution = ${from}::int AND bucket >= ${since.toISOString()}::timestamptz
    ) src
    GROUP BY server_id, b
    ON CONFLICT (server_id, resolution, bucket) DO UPDATE SET
      samples = excluded.samples, cpu_pct = excluded.cpu_pct, cpu_max_pct = excluded.cpu_max_pct,
      memory_bytes = excluded.memory_bytes, memory_max_bytes = excluded.memory_max_bytes, disk_bytes = excluded.disk_bytes,
      rx_bytes_per_sec = excluded.rx_bytes_per_sec, tx_bytes_per_sec = excluded.tx_bytes_per_sec
  `);
}

/**
 * Rekent de laatste 15-min-buckets (venster 1 uur) en uur-buckets (venster 3 uur) opnieuw uit,
 * inclusief de lopende. Het venster begint op een bucketgrens, dus elke bucket wordt volledig herberekend.
 */
export async function rollup(now = new Date()): Promise<void> {
  await rollupLevel(MINUTE, QUARTER, new Date(floorTo(now.getTime() - H, QUARTER)));
  await rollupLevel(QUARTER, HOUR, new Date(floorTo(now.getTime() - 3 * H, HOUR)));
}

/** Verwijdert rijen buiten de bewaartermijn. Geeft het aantal verwijderde rijen. */
export async function prune(now = new Date()): Promise<number> {
  const db = getDb();
  let n = 0;
  for (const [res, keep] of Object.entries(RETENTION_MS)) {
    const r = await db.execute(sql`DELETE FROM server_stats WHERE resolution = ${Number(res)}::int AND bucket < ${new Date(now.getTime() - keep).toISOString()}::timestamptz`);
    n += (r as unknown as { count?: number }).count ?? 0;
  }
  return n;
}

let running = false;

/** Vanuit de scheduler-tik: hooguit eens per minuut, nooit twee rondes tegelijk. */
export async function statsTick(now = Date.now()): Promise<void> {
  if (running || now - lastCollect < COLLECT_EVERY_MS - 5_000) return;
  running = true;
  lastCollect = now;
  try {
    await collectStats(new Date(now));
  } catch (e) {
    console.error("[stats]", e);
  } finally {
    running = false;
  }
}

// ---------- lezen ----------

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** Geschiedenis van één server; elke stap komt precies één keer voor, gaten als null. */
export async function statsHistory(
  serverId: number,
  range: StatsRange,
  limits: { cpuLimitPct: number; memoryLimitBytes: number; diskLimitBytes: number },
  now = new Date(),
): Promise<StatsHistory> {
  const { spanS, stepS, resolution } = RANGES[range];
  const end = floorTo(now.getTime(), stepS) + stepS * 1000;
  const from = end - spanS * 1000;
  const rows = await getDb().execute<Record<string, unknown>>(sql`
    SELECT extract(epoch FROM b) * 1000 AS t,
      sum(cpu_pct::float8 * samples) / sum(samples) AS cpu,
      max(cpu_max_pct) AS cpu_max,
      sum(memory_bytes::float8 * samples) / sum(samples) AS mem,
      max(memory_max_bytes) AS mem_max,
      (array_agg(disk_bytes ORDER BY bucket DESC))[1] AS disk,
      sum(rx_bytes_per_sec::float8 * samples) / nullif(sum(samples) FILTER (WHERE rx_bytes_per_sec IS NOT NULL), 0) AS rx,
      sum(tx_bytes_per_sec::float8 * samples) / nullif(sum(samples) FILTER (WHERE tx_bytes_per_sec IS NOT NULL), 0) AS tx
    FROM (
      SELECT *, date_bin(make_interval(secs => ${stepS}::int), bucket, TIMESTAMPTZ '1970-01-01 00:00:00+00') AS b
      FROM server_stats
      WHERE server_id = ${serverId}::int AND resolution = ${resolution}::int
        AND bucket >= ${new Date(from).toISOString()}::timestamptz AND bucket < ${new Date(end).toISOString()}::timestamptz
    ) src
    GROUP BY b
  `);
  const byT = new Map<number, Record<string, unknown>>();
  for (const r of rows as Iterable<Record<string, unknown>>) byT.set(Math.round(Number(r.t)), r);
  const points: StatsPoint[] = [];
  for (let t = from; t < end; t += stepS * 1000) {
    const r = byT.get(t);
    points.push({
      t: new Date(t),
      cpuPct: num(r?.cpu),
      cpuMaxPct: num(r?.cpu_max),
      memoryBytes: r ? Math.round(Number(r.mem)) : null,
      memoryMaxBytes: num(r?.mem_max),
      diskBytes: num(r?.disk),
      rxBytesPerSec: num(r?.rx),
      txBytesPerSec: num(r?.tx),
    });
  }
  return { range, stepSeconds: stepS, from: new Date(from), to: new Date(end), ...limits, points };
}

export const SPARK_POINTS = 60;

/** Laatste 60 minuten per server (1-min-rijen), voor de serverkaarten. Eén query voor alle servers. */
export async function sparklines(serverIds: number[], now = new Date()): Promise<Map<number, StatsSparkline>> {
  const out = new Map<number, StatsSparkline>();
  if (!serverIds.length) return out;
  const end = floorTo(now.getTime(), MINUTE) + MINUTE * 1000;
  const from = end - SPARK_POINTS * MINUTE * 1000;
  for (const id of serverIds) out.set(id, { cpuPct: Array(SPARK_POINTS).fill(null), memoryBytes: Array(SPARK_POINTS).fill(null) });
  const rows = await getDb()
    .select({ serverId: schema.serverStats.serverId, bucket: schema.serverStats.bucket, cpu: schema.serverStats.cpuPct, mem: schema.serverStats.memoryBytes })
    .from(schema.serverStats)
    .where(and(inArray(schema.serverStats.serverId, serverIds), eq(schema.serverStats.resolution, MINUTE), gte(schema.serverStats.bucket, new Date(from)), lt(schema.serverStats.bucket, new Date(end))));
  for (const r of rows) {
    const i = Math.floor((r.bucket.getTime() - from) / (MINUTE * 1000));
    const s = out.get(r.serverId);
    if (!s || i < 0 || i >= SPARK_POINTS) continue;
    s.cpuPct[i] = r.cpu;
    s.memoryBytes[i] = r.mem;
  }
  return out;
}
