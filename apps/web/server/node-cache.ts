/**
 * Live staat van nodes en servers, buiten het request-pad. Een achtergrondtikker in het panel
 * (één proces tegelijk, via een lease in Redis) vraagt elke paar seconden `/api/system` en
 * `/api/servers` op bij elke node en bewaart het resultaat in geheugen + Redis. Alle lezers
 * (servers.list/get, admin-dashboard, nodepagina's) lezen alleen hieruit en wachten nooit op een
 * daemon. Pushes van de daemon (`/api/remote/servers/{uuid}/status`) werken de cache direct bij.
 *
 * Onbereikbare node: de laatst bekende staat blijft tot `STALE_AFTER_MS`; daarna `unknown`.
 * Zonder Redis (of bij een storing) werkt alles in het geheugen van dit proces en pollt dit
 * proces zelf; meerdere panelprocessen zonder Redis pollen dan allemaal (onschuldig).
 */
import { randomUUID } from "node:crypto";
import type { DaemonSystemInfo, ServerStatus } from "@panel/api";
import { eq } from "drizzle-orm";
import { Redis } from "ioredis";
import { DaemonHttpError, daemonFor } from "./daemon";
import { getDb, schema } from "./db";
import { getEnv } from "./env";

type NodeRow = typeof schema.nodes.$inferSelect;

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const cfg = {
  /** Pauze tussen twee polls van dezelfde (bereikbare) node. */
  get pollMs() { return num(process.env.NODE_POLL_INTERVAL_MS, 5_000); },
  /** Maximale pauze bij een onbereikbare node (verdubbelt per mislukking). */
  get maxBackoffMs() { return num(process.env.NODE_POLL_MAX_BACKOFF_MS, 60_000); },
  /** Ouder dan dit (sinds de laatste geslaagde poll) -> status `unknown`. */
  get staleAfterMs() { return num(process.env.NODE_STALE_AFTER_MS, 30_000); },
  /** Timeout van een poll naar de daemon. */
  get fetchTimeoutMs() { return num(process.env.NODE_POLL_TIMEOUT_MS, 3_000); },
  leaseTtlMs: 15_000,
  /** Hoe lang een lezer een Redis-uitkomst in het geheugen houdt. */
  localTtlMs: 1_000,
};

export interface LiveServer {
  state: ServerStatus;
  installedAt: string | null;
  diskBytes: number | null;
}

export interface NodeLive {
  nodeId: number;
  /** Laatste poging (geslaagd of niet), ms. */
  checkedAt: number;
  /** Laatste geslaagde poll of push, ms. null = nog nooit bereikt. */
  lastSeenAt: number | null;
  online: boolean;
  error: string | null;
  system: DaemonSystemInfo | null;
  servers: Record<string, LiveServer>;
}

// ---------- gedeelde opslag (Redis of geheugen) ----------

export interface SharedStore {
  get(nodeId: number): Promise<NodeLive | null>;
  set(nodeId: number, live: NodeLive): Promise<void>;
  /** Neemt de lease of verlengt hem (als `owner` hem al heeft). */
  lease(owner: string, ttlMs: number): Promise<boolean>;
}

export class MemoryStore implements SharedStore {
  private data = new Map<number, NodeLive>();
  private leaseOwner: string | null = null;
  private leaseUntil = 0;
  constructor(private now: () => number = Date.now) {}
  async get(id: number) {
    const v = this.data.get(id);
    return v ? structuredClone(v) : null;
  }
  async set(id: number, live: NodeLive) {
    this.data.set(id, structuredClone(live));
  }
  async lease(owner: string, ttlMs: number) {
    const t = this.now();
    if (this.leaseOwner === owner || this.leaseUntil <= t || !this.leaseOwner) {
      this.leaseOwner = owner;
      this.leaseUntil = t + ttlMs;
      return true;
    }
    return false;
  }
}

const LEASE_LUA = `local v=redis.call('get',KEYS[1])
if v==ARGV[1] then redis.call('pexpire',KEYS[1],ARGV[2]) return 1 end
if not v then redis.call('set',KEYS[1],ARGV[1],'PX',ARGV[2]) return 1 end
return 0`;

/** Redis; bij een storing lezen we niets (lezers vallen terug op het geheugen) en pollen we zelf. */
export class RedisStore implements SharedStore {
  constructor(private r: Redis, private prefix = "panel:nodelive") {}
  async get(id: number) {
    try {
      const s = await this.r.get(`${this.prefix}:${id}`);
      return s ? (JSON.parse(s) as NodeLive) : null;
    } catch {
      return null;
    }
  }
  async set(id: number, live: NodeLive) {
    try {
      await this.r.set(`${this.prefix}:${id}`, JSON.stringify(live), "EX", 600);
    } catch {
      /* alleen geheugen */
    }
  }
  async lease(owner: string, ttlMs: number) {
    try {
      return Number(await this.r.eval(LEASE_LUA, 1, `${this.prefix}:lease`, owner, String(ttlMs))) === 1;
    } catch {
      return true; // geen Redis: zelf pollen
    }
  }
}

// ---------- toestand van dit proces ----------

interface NodeTiming { failures: number; nextAt: number }

const g = globalThis as unknown as { __panelNodeCache?: State };
interface State {
  store: SharedStore | null;
  redis: Redis | null;
  mem: Map<number, NodeLive>;
  readAt: Map<number, number>;
  timing: Map<number, NodeTiming>;
  nodes: { at: number; rows: NodeRow[] } | null;
  owner: string;
  timer: ReturnType<typeof setInterval> | null;
  busy: boolean;
  running: boolean;
  firstPass: Promise<void> | null;
  resolveFirst: (() => void) | null;
  leader: boolean;
}
const st = (): State =>
  (g.__panelNodeCache ??= {
    store: null, redis: null, mem: new Map(), readAt: new Map(), timing: new Map(), nodes: null,
    owner: randomUUID(), timer: null, busy: false, running: false, firstPass: null, resolveFirst: null, leader: false,
  });

function getStore(): SharedStore {
  const s = st();
  if (s.store) return s.store;
  try {
    const r = new Redis(getEnv().REDIS_URL, { lazyConnect: true, enableOfflineQueue: false, maxRetriesPerRequest: 0, connectTimeout: 1000, commandTimeout: 500, retryStrategy: (n) => Math.min(n * 500, 5000) });
    r.on("error", () => {});
    r.connect().catch(() => {});
    s.redis = r;
    s.store = new RedisStore(r);
  } catch {
    s.store = new MemoryStore();
  }
  return s.store;
}

/** Alleen tests: eigen opslag (bv. een gedeelde MemoryStore voor twee "processen") en schone staat. */
export function resetNodeCache(store?: SharedStore, owner?: string): void {
  const s = st();
  if (s.timer) clearInterval(s.timer);
  s.redis?.disconnect();
  g.__panelNodeCache = undefined;
  if (store || owner) {
    const n = st();
    if (store) n.store = store;
    if (owner) n.owner = owner;
  }
}

// ---------- lezen ----------

/** Laatste bekende staat van een node; wacht nooit op een daemon. null = (nog) niets bekend. */
export async function getNodeLive(nodeId: number, now = Date.now()): Promise<NodeLive | null> {
  const s = st();
  const local = s.mem.get(nodeId);
  const readAt = s.readAt.get(nodeId) ?? 0;
  // Het pollende proces heeft altijd het nieuwste; anderen verversen na localTtlMs uit de opslag.
  if (local && (s.leader || now - readAt < cfg.localTtlMs)) return local;
  if (!local && s.running && s.firstPass) await Promise.race([s.firstPass, new Promise((r) => setTimeout(r, 1500))]);
  const fresh = s.mem.get(nodeId);
  if (fresh && (s.leader || Date.now() - (s.readAt.get(nodeId) ?? 0) < cfg.localTtlMs)) return fresh;
  const shared = await getStore().get(nodeId);
  s.readAt.set(nodeId, Date.now());
  const cur = s.mem.get(nodeId);
  if (shared && (!cur || shared.checkedAt >= cur.checkedAt)) {
    s.mem.set(nodeId, shared);
    return shared;
  }
  return cur ?? null;
}

export async function getNodesLive(nodeIds: number[]): Promise<Map<number, NodeLive | null>> {
  const out = new Map<number, NodeLive | null>();
  await Promise.all([...new Set(nodeIds)].map(async (id) => void out.set(id, await getNodeLive(id))));
  return out;
}

/** Is de cache van deze node te oud (of nooit geslaagd) om er een status uit te halen? */
export function isStale(live: NodeLive, now = Date.now()): boolean {
  return live.lastSeenAt === null || now - live.lastSeenAt > cfg.staleAfterMs;
}

/** Status van een server uit de cache. Geen cache -> DB-status; node te lang weg -> `unknown`. */
export function resolveStatus(live: NodeLive | null, uuid: string, dbStatus: ServerStatus, now = Date.now()): { status: ServerStatus; lastSeenAt: Date | null; installedAt: Date | null } {
  if (!live) return { status: dbStatus, lastSeenAt: null, installedAt: null };
  const lastSeenAt = live.lastSeenAt === null ? null : new Date(live.lastSeenAt);
  if (isStale(live, now)) return { status: "unknown", lastSeenAt, installedAt: null };
  const sv = live.servers[uuid];
  return { status: sv?.state ?? dbStatus, lastSeenAt, installedAt: sv?.installedAt ? new Date(sv.installedAt) : null };
}

// ---------- schrijven ----------

async function put(live: NodeLive): Promise<void> {
  const s = st();
  s.mem.set(live.nodeId, live);
  s.readAt.set(live.nodeId, Date.now());
  await getStore().set(live.nodeId, live);
}

/** Push van de daemon: werkt één server in de cache direct bij. Zonder cache voor de node: niets te doen. */
export async function applyServerState(nodeId: number, uuid: string, state: ServerStatus, installedAt?: Date | null, now = Date.now()): Promise<void> {
  const cur = await getNodeLive(nodeId, now);
  if (!cur) return;
  const prev = cur.servers[uuid];
  await put({
    ...cur,
    lastSeenAt: now,
    online: true,
    error: null,
    servers: { ...cur.servers, [uuid]: { state, installedAt: installedAt === undefined ? (prev?.installedAt ?? null) : (installedAt?.toISOString() ?? null), diskBytes: prev?.diskBytes ?? null } },
  });
}

/** Verwijdert een server uit de cache (na delete/transfer). */
export async function forgetServer(nodeId: number, uuid: string): Promise<void> {
  const cur = await getNodeLive(nodeId);
  if (!cur || !(uuid in cur.servers)) return;
  const { [uuid]: _gone, ...rest } = cur.servers;
  await put({ ...cur, servers: rest });
}

// ---------- pollen ----------

export interface Fetcher {
  system(node: NodeRow, timeoutMs: number): Promise<DaemonSystemInfo>;
  servers(node: NodeRow, timeoutMs: number): Promise<{ uuid: string; state: string; installed_at?: string | null; disk_bytes?: number }[]>;
}
const defaultFetcher: Fetcher = {
  system: (n, t) => daemonFor(n).system(t),
  servers: (n, t) => daemonFor(n).listServers(t),
};
let fetcher: Fetcher = defaultFetcher;
/** Alleen tests. */
export function setFetcher(f: Fetcher | null): void {
  fetcher = f ?? defaultFetcher;
}

/** Haalt één node op en schrijft het resultaat; mislukking bewaart de oude staat met `online: false`. */
export async function pollNode(node: NodeRow, now = Date.now()): Promise<NodeLive> {
  const prev = st().mem.get(node.id) ?? null;
  const t = cfg.fetchTimeoutMs;
  let live: NodeLive;
  try {
    const [sys, list] = await Promise.all([fetcher.system(node, t), fetcher.servers(node, t)]);
    const servers: Record<string, LiveServer> = {};
    for (const x of list) servers[x.uuid] = { state: x.state as ServerStatus, installedAt: x.installed_at ?? null, diskBytes: x.disk_bytes ?? null };
    live = { nodeId: node.id, checkedAt: now, lastSeenAt: now, online: true, error: null, system: sys, servers };
  } catch (e) {
    const msg = e instanceof DaemonHttpError ? `${e.status} ${e.message}` : ((e as Error).message ?? String(e));
    live = { nodeId: node.id, checkedAt: now, lastSeenAt: prev?.lastSeenAt ?? null, online: false, error: msg.slice(0, 300), system: prev?.system ?? null, servers: prev?.servers ?? {} };
  }
  await put(live);
  if (live.online) await syncDb(node, live, prev);
  return live;
}

/** Schrijft veranderde staten (en versie/quotamodus) terug naar de database. */
async function syncDb(node: NodeRow, live: NodeLive, prev: NodeLive | null): Promise<void> {
  const db = getDb();
  try {
    const sys = live.system;
    if (sys && (sys.version !== node.daemonVersion || sys.disk_quota_mode !== node.diskQuotaMode)) {
      await db.update(schema.nodes).set({ diskQuotaMode: sys.disk_quota_mode, daemonVersion: sys.version, lastSeenAt: new Date(live.checkedAt) }).where(eq(schema.nodes.id, node.id));
      const cached = st().nodes?.rows.find((r) => r.id === node.id);
      if (cached) Object.assign(cached, { diskQuotaMode: sys.disk_quota_mode, daemonVersion: sys.version });
    }
    const same = prev?.online && JSON.stringify(Object.entries(prev.servers).map(([u, v]) => [u, v.state, v.installedAt])) === JSON.stringify(Object.entries(live.servers).map(([u, v]) => [u, v.state, v.installedAt]));
    if (same) return;
    const rows = await db.select({ id: schema.servers.id, uuid: schema.servers.uuid, status: schema.servers.status, installedAt: schema.servers.installedAt }).from(schema.servers).where(eq(schema.servers.nodeId, node.id));
    for (const r of rows) {
      const sv = live.servers[r.uuid];
      if (!sv) continue;
      const installedAt = r.installedAt ?? (sv.installedAt ? new Date(sv.installedAt) : null);
      if (sv.state !== r.status || installedAt?.getTime() !== r.installedAt?.getTime()) await db.update(schema.servers).set({ status: sv.state, installedAt }).where(eq(schema.servers.id, r.id));
    }
  } catch (e) {
    console.error("[node-monitor] db sync:", (e as Error).message);
  }
}

async function loadNodes(now: number): Promise<NodeRow[]> {
  const s = st();
  if (s.nodes && now - s.nodes.at < 10_000) return s.nodes.rows;
  const rows = await getDb().select().from(schema.nodes);
  s.nodes = { at: now, rows };
  return rows;
}

/** Direct één node verversen (na een power-actie of een hello); fouten worden ingeslikt. */
export async function refreshNodeNow(nodeId: number): Promise<void> {
  try {
    const [n] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
    if (n) {
      await pollNode(n);
      st().timing.set(n.id, { failures: 0, nextAt: Date.now() + cfg.pollMs });
    }
  } catch {
    /* de tikker probeert het opnieuw */
  }
}

/** Alleen voor tests/bench: alle nodes één keer pollen, ongeacht de planning. */
export async function pollAllNow(now = Date.now()): Promise<void> {
  const rows = await getDb().select().from(schema.nodes);
  st().nodes = { at: now, rows };
  await Promise.all(rows.map((n) => pollNode(n, now)));
}

/** Eén tik van de monitor: lease nemen/verlengen, dan alle nodes pollen die aan de beurt zijn. */
export async function monitorNodesTick(now = Date.now()): Promise<{ leader: boolean; polled: number[] }> {
  const s = st();
  const leader = await getStore().lease(s.owner, cfg.leaseTtlMs);
  s.leader = leader;
  if (!leader) return { leader, polled: [] };
  const due = (await loadNodes(now)).filter((n) => (s.timing.get(n.id)?.nextAt ?? 0) <= now);
  await Promise.all(
    due.map(async (n) => {
      const live = await pollNode(n, now);
      const failures = live.online ? 0 : (s.timing.get(n.id)?.failures ?? 0) + 1;
      const delay = Math.min(cfg.pollMs * 2 ** Math.min(failures, 10), cfg.maxBackoffMs);
      s.timing.set(n.id, { failures, nextAt: now + delay });
    }),
  );
  return { leader, polled: due.map((n) => n.id) };
}

/** Voor het monitor-/notificatiecircuit: is deze node nu bereikbaar volgens de cache? */
export async function nodeSeenWithin(nodeId: number, ms: number): Promise<boolean> {
  const l = await getNodeLive(nodeId);
  return !!l && l.lastSeenAt !== null && Date.now() - l.lastSeenAt <= ms;
}

export function startNodeMonitor(tickMs = 1000): void {
  const s = st();
  if (s.timer) return;
  s.running = true;
  s.firstPass = new Promise<void>((r) => (s.resolveFirst = r));
  const run = () => {
    if (s.busy) return;
    s.busy = true;
    monitorNodesTick()
      .catch((e) => console.error("[node-monitor]", e))
      .finally(() => {
        s.busy = false;
        s.resolveFirst?.();
      });
  };
  s.timer = setInterval(run, tickMs);
  s.timer.unref();
  run();
}

export function stopNodeMonitor(): void {
  const s = st();
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  s.running = false;
}
