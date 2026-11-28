/**
 * Openbare statuspagina's (/status/<slug>) en de uptime-metingen erachter.
 *
 * - Uptime: elke minuut (monitor-tik) één meting per server in `server_uptime` (per uur opgeteld).
 *   `last_minute` voorkomt dubbel tellen als twee panelprocessen tegelijk meten.
 * - Openbaar antwoord: alleen naam, type, staat, spelers, uptime en (als de eigenaar dat wil) het
 *   adres. Geen uuid's, node, eigenaar of IP's. Gecachet per slug (CACHE_MS) met één lopende
 *   berekening per slug, ook voor onbekende slugs, zodat veel bezoekers de database niet raken.
 */
import { contentProfile, type PublicServerState, type PublicStatus, type PublicStatusServer, type ServerStatus, type StatusPage } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { call, daemonFor } from "./daemon";
import { getDb, schema } from "./db";
import { getNodesLive, resolveStatus } from "./node-cache";
import { fetchServers, type ServerBundle } from "./servers-data";
import { getSettings } from "./settings";

type PageRow = typeof schema.statusPages.$inferSelect;

// ---------- uptime ----------

/** Telt als "bereikbaar" voor de uptime. */
const UP: readonly ServerStatus[] = ["online", "sleeping"];
/** Niet meten: gepland onderhoud of nog niet klaar. */
const SKIP: readonly ServerStatus[] = ["installing", "install_failed"];

/** Eén meting voor alle servers (aanroep elke minuut). */
export async function sampleUptime(now = new Date()): Promise<number> {
  const db = getDb();
  const rows = await db.select({ id: schema.servers.id, uuid: schema.servers.uuid, nodeId: schema.servers.nodeId, status: schema.servers.status, suspendedAt: schema.servers.suspendedAt }).from(schema.servers);
  if (!rows.length) return 0;
  const lives = await getNodesLive([...new Set(rows.map((r) => r.nodeId))]);
  const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
  const minute = now.getUTCMinutes();
  const values = rows
    .map((r) => ({ r, st: resolveStatus(lives.get(r.nodeId) ?? null, r.uuid, r.status, now.getTime()).status }))
    .filter(({ r, st }) => !r.suspendedAt && !SKIP.includes(st))
    .map(({ r, st }) => ({ serverId: r.id, hour, upMinutes: UP.includes(st) ? 1 : 0, totalMinutes: 1, lastMinute: minute }));
  if (!values.length) return 0;
  const u = schema.serverUptime;
  await db
    .insert(u)
    .values(values)
    .onConflictDoUpdate({
      target: [u.serverId, u.hour],
      set: { upMinutes: sql`${u.upMinutes} + excluded.up_minutes`, totalMinutes: sql`${u.totalMinutes} + 1`, lastMinute: sql`excluded.last_minute` },
      setWhere: sql`${u.lastMinute} <> excluded.last_minute`,
    });
  return values.length;
}

/** Metingen ouder dan 8 dagen weg. */
export async function cleanupUptime(now = new Date()): Promise<void> {
  // lt() i.p.v. een rauwe sql-template: die geeft de Date ongemapt door en postgres-js weigert dat.
  await getDb().delete(schema.serverUptime).where(lt(schema.serverUptime.hour, new Date(now.getTime() - 8 * 86_400_000)));
}

const pct = (up: number, total: number) => (total ? Math.round((up * 10_000) / total) / 100 : null);

/** Uptime per server: 24 uur-vakjes, 7 dag-vakjes (rollend, oudste eerst) en de totalen. */
export async function uptimeFor(serverIds: number[], now = new Date()) {
  const out = new Map<number, { uptime24h: number | null; uptime7d: number | null; hours: (number | null)[]; days: (number | null)[] }>();
  if (!serverIds.length) return out;
  const thisHour = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  const from = new Date(thisHour - 167 * 3_600_000);
  const rows = await getDb()
    .select()
    .from(schema.serverUptime)
    .where(and(inArray(schema.serverUptime.serverId, serverIds), gte(schema.serverUptime.hour, from)));
  for (const id of serverIds) {
    const mine = rows.filter((r) => r.serverId === id);
    const slot = (h: number) => mine.find((r) => r.hour.getTime() === h);
    const sum = (startH: number, n: number) => {
      let up = 0;
      let total = 0;
      for (let i = 0; i < n; i++) {
        const r = slot(startH + i * 3_600_000);
        if (r) (up += r.upMinutes), (total += r.totalMinutes);
      }
      return [up, total] as const;
    };
    const hours = Array.from({ length: 24 }, (_, i) => {
      const r = slot(thisHour - (23 - i) * 3_600_000);
      return r ? pct(r.upMinutes, r.totalMinutes) : null;
    });
    const days = Array.from({ length: 7 }, (_, i) => pct(...sum(thisHour - (167 - i * 24) * 3_600_000, 24)));
    out.set(id, { uptime24h: pct(...sum(thisHour - 23 * 3_600_000, 24)), uptime7d: pct(...sum(from.getTime(), 168)), hours, days });
  }
  return out;
}

// ---------- openbaar antwoord ----------

const MC_SLUG = /minecraft|vanilla|purpur|spigot|forge|quilt|velocity|bungee|waterfall/;
export const isMinecraft = (slug: string) => !!contentProfile(slug) || MC_SLUG.test(slug);

function publicState(b: ServerBundle, st: ServerStatus): PublicServerState {
  if (b.server.suspendedAt || st === "installing" || st === "install_failed") return "maintenance";
  // Node in onderhoud: een server die niet draait is "in onderhoud", niet "offline".
  if (b.node.maintenance && st !== "online" && st !== "starting" && st !== "sleeping") return "maintenance";
  switch (st) {
    case "online":
      return "online";
    case "starting":
      return "starting";
    case "sleeping":
      return "sleeping";
    case "unknown":
      return "unknown";
    default:
      return "offline";
  }
}

/** Vervangbaar in tests. */
export const playerProbe = {
  fetch: async (b: ServerBundle): Promise<{ online: number; max: number } | null> => {
    const r = await call(() => daemonFor(b.node).players(b.server.uuid, 2500));
    return typeof r.online === "number" && typeof r.max === "number" ? { online: r.online, max: r.max } : null;
  },
};

async function computePublic(slug: string): Promise<PublicStatus | null> {
  const db = getDb();
  const [page] = await db.select().from(schema.statusPages).where(and(eq(schema.statusPages.slug, slug), eq(schema.statusPages.enabled, true)));
  if (!page) return null;
  const links = await db.select().from(schema.statusPageServers).where(eq(schema.statusPageServers.pageId, page.id)).orderBy(asc(schema.statusPageServers.position));
  const ids = links.map((l) => l.serverId);
  const bundles = ids.length ? await fetchServers(inArray(schema.servers.id, ids)) : [];
  // Netwerkpagina's: alleen servers die (nog) van de eigenaar van de pagina zijn.
  const byId = new Map(bundles.filter((b) => page.kind === "server" || b.server.ownerId === page.ownerId).map((b) => [b.server.id, b]));
  const ordered = ids.map((id) => byId.get(id)).filter((b): b is ServerBundle => !!b);
  const lives = await getNodesLive([...new Set(ordered.map((b) => b.node.id))]);
  const uptime = await uptimeFor(ordered.map((b) => b.server.id));
  const now = Date.now();
  const servers = await Promise.all(
    ordered.map(async (b): Promise<PublicStatusServer> => {
      const st = resolveStatus(lives.get(b.node.id) ?? null, b.server.uuid, b.server.status, now).status;
      const state = publicState(b, st);
      let players: PublicStatusServer["players"] = null;
      if (page.showPlayers && b.server.type === "game" && state === "online" && isMinecraft(b.template.slug)) players = await playerProbe.fetch(b).catch(() => null);
      const primary = b.allocations.find((a) => a.isPrimary) ?? b.allocations[0];
      const address = !page.showAddress ? null : b.server.type === "web" ? (b.domains[0] ?? null) : (b.domains[0] ?? (primary ? `${primary.ip}:${primary.port}` : null));
      const u = uptime.get(b.server.id) ?? { uptime24h: null, uptime7d: null, hours: Array(24).fill(null), days: Array(7).fill(null) };
      return { name: b.server.name, type: b.server.type, state, players, ...u, address };
    }),
  );
  const s = await getSettings();
  const counted = servers.filter((x) => x.state !== "maintenance");
  const up = counted.filter((x) => x.state === "online" || x.state === "sleeping" || x.state === "starting").length;
  const unknown = counted.filter((x) => x.state === "unknown").length;
  const overall: PublicStatus["overall"] = !counted.length ? "unknown" : unknown === counted.length ? "unknown" : up === counted.length ? "operational" : up === 0 && !unknown ? "down" : "degraded";
  return {
    title: page.title,
    description: page.description,
    kind: page.kind,
    branding: { panelName: s.panelName, logoUrl: s.logoUrl, accentColor: s.accentColor },
    overall,
    servers,
    updatedAt: new Date(),
  };
}

export const CACHE_MS = 30_000;
const MAX_ENTRIES = 1000;
const cache = new Map<string, { at: number; value: PublicStatus | null }>();
const pending = new Map<string, Promise<PublicStatus | null>>();
export const statusStats = { computed: 0 };

/** Alleen voor tests en na een wijziging. */
export function invalidateStatus(slug?: string): void {
  if (slug) cache.delete(slug);
  else cache.clear();
}

/** Openbare status (gecachet). Onbekend of uit → null. */
export async function publicStatus(rawSlug: string, now = Date.now()): Promise<PublicStatus | null> {
  const slug = rawSlug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(slug)) return null;
  const hit = cache.get(slug);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const run = pending.get(slug);
  if (run) return run;
  const p = (async () => {
    statusStats.computed++;
    try {
      const value = await computePublic(slug);
      if (cache.size >= MAX_ENTRIES) {
        for (const [k, v] of cache) if (now - v.at >= CACHE_MS || cache.size >= MAX_ENTRIES) cache.delete(k);
      }
      cache.set(slug, { at: Date.now(), value });
      return value;
    } catch (e) {
      // Bij een storing: de laatste bekende stand blijft bruikbaar.
      if (hit) return hit.value;
      throw e;
    } finally {
      pending.delete(slug);
    }
  })();
  pending.set(slug, p);
  return p;
}

// ---------- beheer ----------

export async function pageView(p: PageRow): Promise<StatusPage> {
  const rows = await getDb()
    .select({ uuid: schema.servers.uuid, name: schema.servers.name })
    .from(schema.statusPageServers)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.statusPageServers.serverId))
    .where(eq(schema.statusPageServers.pageId, p.id))
    .orderBy(asc(schema.statusPageServers.position));
  return { id: p.id, slug: p.slug, kind: p.kind, title: p.title, description: p.description, enabled: p.enabled, showAddress: p.showAddress, showPlayers: p.showPlayers, servers: rows, createdAt: p.createdAt };
}

export const slugTaken = () => new TRPCError({ code: "CONFLICT", message: "SLUG_TAKEN" });

/** Unieke-sleutelfout van Postgres op de slug. */
export function isUniqueViolation(e: unknown): boolean {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code === "23505" || x?.cause?.code === "23505";
}

export async function setPageServers(pageId: number, serverIds: number[]): Promise<void> {
  const db = getDb();
  await db.delete(schema.statusPageServers).where(eq(schema.statusPageServers.pageId, pageId));
  if (serverIds.length) await db.insert(schema.statusPageServers).values(serverIds.map((serverId, position) => ({ pageId, serverId, position })));
}
