/**
 * Databasetunnels voor phpMyAdmin naar de MariaDB van remote nodes.
 *
 * phpMyAdmin (container op het interne netwerk `backend`) verbindt voor een remote node met `panel:<poort>`. Het panel
 * luistert daarvoor per node op PMA_TUNNEL_BIND:(PMA_TUNNEL_PORT_BASE + node-id) en stuurt elke verbinding door via
 * de daemon van die node: GET /api/db/tunnel (HTTP-upgrade over de bestaande daemon-HTTPS met het node-token). De
 * daemon verbindt alleen met zijn eigen MariaDB-container. Zo staat MariaDB op geen enkele node open naar buiten.
 *
 * - Alleen verbindingen van loopback en van PMA_TUNNEL_ALLOW (standaard de container `phpmyadmin`) worden aangenomen.
 * - De tunnel geeft geen databaserechten: phpMyAdmin meldt zich daarna aan met het account `pma_u<id>` van de gebruiker.
 * - Node offline: de verbinding gaat direct dicht; phpMyAdmin toont dan een fout voor alleen die server.
 * - Elke verbinding haalt de node opnieuw uit de database (token/fqdn altijd actueel); per poort hoogstens 64 tegelijk.
 */
import { lookup } from "node:dns/promises";
import { isIP, createServer, type Server, type Socket } from "node:net";
import { and, eq } from "drizzle-orm";
import { daemonFor } from "./daemon";
import { getDb, schema } from "./db";
import { getEnv } from "./env";

const MAX_CONNECTIONS = 64;
const IDLE_MS = 15 * 60_000;
const CONNECT_TIMEOUT_MS = 10_000;

interface Tunnel {
  server: Server;
  port: Promise<number>;
}

const g = globalThis as unknown as { __panelPmaTunnels?: Map<number, Tunnel> };
const tunnels = (g.__panelPmaTunnels ??= new Map());

// ---------- wie mag verbinden ----------

let allowCache: { at: number; key: string; ips: Set<string> } | null = null;

const normalize = (ip: string) => (ip.startsWith("::ffff:") ? ip.slice(7) : ip);
const isLoopback = (ip: string) => ip === "::1" || ip.startsWith("127.");

async function allowedIps(): Promise<Set<string>> {
  const list = getEnv().PMA_TUNNEL_ALLOW;
  const key = list.join(",");
  if (allowCache && allowCache.key === key && Date.now() - allowCache.at < 30_000) return allowCache.ips;
  const ips = new Set<string>();
  await Promise.all(
    list.map(async (h) => {
      if (isIP(h)) return void ips.add(normalize(h));
      try {
        for (const a of await lookup(h, { all: true })) ips.add(normalize(a.address));
      } catch {
        /* host (nog) niet te vinden: niemand via die naam */
      }
    }),
  );
  allowCache = { at: Date.now(), key, ips };
  return ips;
}

/** Alleen tests. */
export function resetTunnelAllowCache(): void {
  allowCache = null;
}

export async function clientAllowed(remote: string | undefined): Promise<boolean> {
  if (!remote) return false;
  const ip = normalize(remote);
  if (isLoopback(ip)) return true;
  if ((await allowedIps()).has(ip)) return true;
  // Mogelijk is het adres van phpMyAdmin net veranderd (herstart): één keer opnieuw opzoeken.
  allowCache = null;
  return (await allowedIps()).has(ip);
}

// ---------- doorsturen ----------

async function forward(nodeId: number, client: Socket): Promise<void> {
  client.pause();
  client.setNoDelay(true);
  client.setKeepAlive(true, 30_000);
  client.on("error", () => client.destroy());
  if (!(await clientAllowed(client.remoteAddress))) {
    console.warn(`[pma-tunnel] node ${nodeId}: verbinding van ${client.remoteAddress} geweigerd`);
    client.destroy();
    return;
  }
  let upstream: Socket;
  try {
    const [node] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, nodeId));
    if (!node || node.isLocal) throw new Error("node unknown");
    upstream = await daemonFor(node).dbTunnel(CONNECT_TIMEOUT_MS);
  } catch (e) {
    console.warn(`[pma-tunnel] node ${nodeId}: ${(e as Error).message}`);
    client.destroy();
    return;
  }
  if (client.destroyed) {
    upstream.destroy();
    return;
  }
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  upstream.setNoDelay(true);
  upstream.setKeepAlive(true, 30_000);
  for (const s of [client, upstream]) {
    s.on("error", close);
    s.on("close", close);
    s.setTimeout(IDLE_MS, close);
  }
  upstream.pipe(client);
  client.pipe(upstream);
  client.resume();
}

/** Poort van de tunnel van een node (vast: base + id), of 0 als het besturingssysteem kiest (PMA_TUNNEL_PORT_BASE=0). */
export function tunnelPortFor(nodeId: number): number {
  const base = getEnv().PMA_TUNNEL_PORT_BASE;
  return base === 0 ? 0 : base + nodeId;
}

/** Zorgt dat de tunnel van een remote node luistert; geeft de poort. Idempotent. */
export function ensureTunnel(nodeId: number): Promise<number> {
  const have = tunnels.get(nodeId);
  if (have) return have.port;
  const server = createServer((c) => void forward(nodeId, c).catch(() => c.destroy()));
  server.maxConnections = MAX_CONNECTIONS;
  const port = new Promise<number>((resolve, reject) => {
    server.once("error", (e) => {
      tunnels.delete(nodeId);
      reject(e);
    });
    server.listen(tunnelPortFor(nodeId), getEnv().PMA_TUNNEL_BIND, () => {
      server.on("error", (e) => console.error(`[pma-tunnel] node ${nodeId}:`, e));
      resolve((server.address() as { port: number }).port);
    });
  });
  tunnels.set(nodeId, { server, port });
  return port;
}

/** Bij de start: tunnels voor alle remote nodes met een daemon-beheerde MariaDB (bestaande phpMyAdmin-sessies blijven werken). */
export async function startTunnels(): Promise<void> {
  const rows = await getDb()
    .selectDistinct({ id: schema.nodes.id })
    .from(schema.databaseHosts)
    .innerJoin(schema.nodes, eq(schema.nodes.id, schema.databaseHosts.nodeId))
    .where(and(eq(schema.databaseHosts.daemonManaged, true), eq(schema.nodes.isLocal, false)));
  for (const r of rows) {
    await ensureTunnel(r.id).catch((e) => console.error(`[pma-tunnel] node ${r.id}: listen:`, e));
  }
}

/** Alleen tests / afsluiten. */
export async function closeTunnels(): Promise<void> {
  const all = [...tunnels.values()];
  tunnels.clear();
  await Promise.all(all.map((t) => new Promise<void>((r) => t.server.close(() => r()))));
}
