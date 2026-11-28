/**
 * Achtergrondcontroles die meldingen opleveren: node offline/terug en SSL-fouten van domeinen.
 * Draait vanuit de scheduler-tikker (zie `monitorTick`). De controles zelf zijn injecteerbaar
 * voor tests; de staat zit in het geheugen (na een herstart van het panel begint hij leeg, zodat
 * een node die dan al offline is opnieuw gemeld wordt).
 */
import { and, eq, ne } from "drizzle-orm";
import { call, daemonFor } from "./daemon";
import { getDb, schema } from "./db";
import { cfg, getNodeLive, isStale } from "./node-cache";
import { notify, serverHookOf, targetForServer, type Target } from "./notify";
import { sampleUptime } from "./status-pages";

type NodeRow = typeof schema.nodes.$inferSelect;

/** Aantal opeenvolgende mislukte controles voordat een node als offline geldt (tegen flapperen). */
export const OFFLINE_AFTER = 2;
export const MONITOR_EVERY_MS = 60_000;

const failures = new Map<number, number>();
const reported = new Set<number>();

/** Alleen voor tests. */
export function resetMonitor(): void {
  failures.clear();
  reported.clear();
  lastRun = 0;
}

export type NodeProbe = (n: NodeRow) => Promise<void>;
const defaultProbe: NodeProbe = async (n) => {
  // De node-monitor pollt al elke paar seconden: gebruik zijn uitkomst als die vers is.
  const live = await getNodeLive(n.id);
  if (live && !isStale(live)) return;
  if (live && live.checkedAt > Date.now() - cfg.staleAfterMs) throw new Error(live.error ?? "no response");
  await daemonFor(n).system(3000);
};

/** Admins plus de eigenaren (en serverwebhooks) van de servers op de node. */
async function nodeTarget(nodeId: number): Promise<Target> {
  const rows = await getDb().select({ ownerId: schema.servers.ownerId, hook: schema.servers.discordWebhookEnc }).from(schema.servers).where(eq(schema.servers.nodeId, nodeId));
  return {
    server: null,
    hooks: [...new Set(rows.map((r) => serverHookOf({ discordWebhookEnc: r.hook })).filter((h): h is string => !!h))],
    admin: true,
    users: [...new Set(rows.map((r) => r.ownerId))],
  };
}

export async function checkNodes(probe: NodeProbe = defaultProbe): Promise<void> {
  const nodes = await getDb().select().from(schema.nodes);
  await Promise.all(
    nodes.map(async (n) => {
      try {
        await probe(n);
        failures.delete(n.id);
        if (reported.delete(n.id)) await notify({ kind: "node_online", nodeName: n.name }, await nodeTarget(n.id));
      } catch (e) {
        const c = (failures.get(n.id) ?? 0) + 1;
        failures.set(n.id, c);
        if (c >= OFFLINE_AFTER && !reported.has(n.id)) {
          reported.add(n.id);
          await notify({ kind: "node_offline", nodeName: n.name, error: ((e as Error).message ?? String(e)).slice(0, 300) }, await nodeTarget(n.id));
        }
      }
    }),
  );
}

type RouteStatuses = (n: NodeRow) => Promise<{ host: string; ssl_status: string }[]>;
const defaultRoutes: RouteStatuses = (n) => call(() => daemonFor(n).routes(3000));

/**
 * Werkt ssl_status van de webdomeinen bij met wat de daemon meldt en meldt de overgang naar
 * `failed` (één keer per overgang). Nodes die niet antwoorden worden overgeslagen.
 */
export async function checkSsl(routes: RouteStatuses = defaultRoutes): Promise<void> {
  const db = getDb();
  const nodes = await db.select().from(schema.nodes);
  for (const n of nodes) {
    let st;
    try {
      st = await routes(n);
    } catch {
      continue;
    }
    const byHost = new Map(st.map((r) => [r.host, r.ssl_status]));
    const rows = await db
      .select({ d: schema.domains, serverId: schema.servers.id })
      .from(schema.domains)
      .innerJoin(schema.servers, eq(schema.servers.id, schema.domains.serverId))
      .where(and(eq(schema.servers.nodeId, n.id), ne(schema.domains.protocol, "minecraft")));
    for (const { d, serverId } of rows) {
      const next = byHost.get(d.wildcard ? `*.${d.hostname}` : d.hostname) as typeof d.sslStatus | undefined;
      if (!next || next === d.sslStatus) continue;
      await db.update(schema.domains).set({ sslStatus: next }).where(eq(schema.domains.id, d.id));
      if (next === "failed") await notifySslFailed(serverId, d.hostname);
    }
  }
}

export async function notifySslFailed(serverId: number, hostname: string): Promise<void> {
  const target = await targetForServer(serverId).catch(() => null);
  if (target) await notify({ kind: "ssl_failed", hostname }, target);
}

let lastRun = 0;
let running = false;

/** Vanuit de scheduler-tik: hooguit eens per minuut. */
export async function monitorTick(now = Date.now()): Promise<void> {
  if (running || now - lastRun < MONITOR_EVERY_MS) return;
  running = true;
  lastRun = now;
  try {
    await checkNodes();
    await checkSsl();
    await sampleUptime();
  } catch (e) {
    console.error("[monitor]", e);
  } finally {
    running = false;
  }
}
