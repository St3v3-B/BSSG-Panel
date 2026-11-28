/**
 * HTTP(S)-relay tussen nodes (zie daemon/internal/relay): een node (B) zonder eigen 80/443 laat al zijn HTTP(S)
 * lopen via een relay-node (A). Het panel is de bron van waarheid: het geeft per paar een geheim uit, levert beide
 * daemons hun config (GET /api/remote/relay), bepaalt welke hostnamen A voor B mag doorsturen (alleen de webdomeinen
 * van servers op B plus B's node-domein), en wijst DNS van B's HTTP(S)-namen naar A. Gamepoorten en SFTP gaan
 * direct naar B, dus records daarvoor (Minecraft A/SRV, allocaties) blijven B's eigen IP.
 */
import type { NodeRelayStatus, RelayDnsRecord } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, isNotNull, ne } from "drizzle-orm";
import { call, daemonFor, type NodeRef } from "./daemon";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { CloudflareError, setARecord, zoneFor } from "./lib/cloudflare";
import { decrypt, encrypt, randomToken } from "./lib/crypto";
import { dns } from "./lib/dns";
import { publicPanelUrl } from "./routers/nodes";

type NodeRow = typeof schema.nodes.$inferSelect;
type DomainRow = typeof schema.domains.$inferSelect;
type IpNode = NodeRef & { httpRelayNodeId?: number | null; publicIp?: string | null };

// ---------- IP's ----------

const ipCache = new Map<number, { ip: string; until: number }>();
export const resetNodeIpCache = () => ipCache.clear();

async function rowOf(id: number): Promise<NodeRow | null> {
  const [n] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, id));
  return n ?? null;
}

/**
 * Het eigen (directe) IP van een node: gamepoorten, SFTP en Minecraft-records. NODE_PUBLIC_IP (lokale node),
 * anders het A-record van de node. Loopt de node via een relay, dan wijst zijn domein naar de relay-node: dan het
 * door join gemelde IP of dat van een allocatie.
 */
export async function nodeIp(node: IpNode): Promise<string> {
  const env = getEnv();
  if (node.isLocal && env.NODE_PUBLIC_IP) return env.NODE_PUBLIC_IP;
  const c = ipCache.get(node.id);
  if (c && c.until > Date.now()) return c.ip;
  let relayed = node.httpRelayNodeId;
  let publicIp = node.publicIp;
  if (relayed === undefined) {
    const row = await rowOf(node.id);
    relayed = row?.httpRelayNodeId ?? null;
    publicIp = row?.publicIp ?? null;
  }
  let ip: string | undefined;
  if (relayed) {
    ip = await knownIp(node.id, publicIp ?? null);
    if (!ip) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NODE_IP_UNKNOWN: the node domain points to the relay node; no public IP known for this node (join or allocation)" });
  } else {
    [ip] = await dns().a(node.fqdn);
  }
  if (!ip) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NODE_IP_UNKNOWN: set NODE_PUBLIC_IP" });
  ipCache.set(node.id, { ip, until: Date.now() + 10 * 60_000 });
  return ip;
}

/** Het IP dat het panel zelf van een node kent: door join gemeld, anders dat van een allocatie. */
async function knownIp(nodeId: number, publicIp: string | null): Promise<string | undefined> {
  if (publicIp) return publicIp;
  const [a] = await getDb().select({ ip: schema.allocations.ip }).from(schema.allocations).where(eq(schema.allocations.nodeId, nodeId)).orderBy(asc(schema.allocations.id)).limit(1);
  return a?.ip;
}

/** De node die HTTP(S) voor `node` aanneemt: de relay-node, of de node zelf. */
export async function httpEntry(node: IpNode): Promise<IpNode> {
  let relayId = node.httpRelayNodeId;
  if (relayId === undefined) relayId = (await rowOf(node.id))?.httpRelayNodeId ?? null;
  if (!relayId) return node;
  const a = await rowOf(relayId);
  if (!a) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "RELAY_NODE_MISSING" });
  return a;
}

/** IP voor HTTP(S)-records (webdomeinen, node-domein): het IP van de relay-node, of het eigen IP. */
export async function httpIp(node: IpNode): Promise<string> {
  return nodeIp(await httpEntry(node));
}

// ---------- config voor de daemons ----------

export const routeHostOf = (d: Pick<DomainRow, "hostname" | "wildcard">) => (d.wildcard ? `*.${d.hostname}` : d.hostname);

type RelayHost = { host: string; wildcard: boolean; dns_challenge: { provider: "cloudflare"; api_token: string } | null };

/** De HTTP-hostnamen van alle servers op een node: precies wat de relay voor die node mag doorsturen. */
export async function relayHosts(nodeId: number): Promise<RelayHost[]> {
  const db = getDb();
  const rows = await db
    .select({ d: schema.domains })
    .from(schema.domains)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.domains.serverId))
    .where(and(eq(schema.servers.nodeId, nodeId), ne(schema.domains.protocol, "minecraft")))
    .orderBy(asc(schema.domains.id));
  const providers = new Map((await db.select().from(schema.dnsProviders)).map((p) => [p.id, p]));
  return rows.map(({ d }) => {
    const p = d.wildcard && d.dnsProviderId ? providers.get(d.dnsProviderId) : undefined;
    return { host: routeHostOf(d), wildcard: d.wildcard, dns_challenge: p ? { provider: "cloudflare" as const, api_token: decrypt(p.apiTokenEnc) } : null };
  });
}

export interface RelayConfig {
  edge: { node_id: number; url: string; fqdn: string; client_id: number; secret: string } | null;
  clients: { node_id: number; fqdn: string; secret: string; hosts: RelayHost[] }[];
}

/** GET /api/remote/relay voor een node. */
export async function relayConfigFor(node: NodeRow): Promise<RelayConfig> {
  let edge: RelayConfig["edge"] = null;
  if (node.httpRelayNodeId && node.relaySecretEnc) {
    const a = await rowOf(node.httpRelayNodeId);
    if (a) edge = { node_id: a.id, url: `https://${a.fqdn}`, fqdn: a.fqdn, client_id: node.id, secret: decrypt(node.relaySecretEnc) };
  }
  const rows = await getDb()
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.httpRelayNodeId, node.id), isNotNull(schema.nodes.relaySecretEnc)))
    .orderBy(asc(schema.nodes.id));
  const clients: RelayConfig["clients"] = [];
  for (const b of rows) clients.push({ node_id: b.id, fqdn: b.fqdn, secret: decrypt(b.relaySecretEnc!), hosts: await relayHosts(b.id) });
  return { edge, clients };
}

/** Vraagt daemons hun relay-config nu op te halen (best effort; ze doen het anders binnen een minuut zelf). */
export const pokeTimeoutMs = { value: 4000 };
export async function pokeRelay(nodeIds: (number | null | undefined)[]): Promise<void> {
  const ids = [...new Set(nodeIds.filter((x): x is number => typeof x === "number"))];
  await Promise.all(
    ids.map(async (id) => {
      const n = await rowOf(id);
      if (!n) return;
      try {
        await daemonFor(n).relayRefresh(pokeTimeoutMs.value);
      } catch {
        /* de node haalt het zelf op */
      }
    }),
  );
}

/** Na een domeinwijziging op een node: de relay-node moet de nieuwe hostnamen kennen. */
export async function domainsChanged(node: IpNode): Promise<void> {
  let relayId = node.httpRelayNodeId;
  if (relayId === undefined) relayId = (await rowOf(node.id))?.httpRelayNodeId ?? null;
  if (relayId) await pokeRelay([relayId]);
}

// ---------- SSL-status ----------

/** SSL-status van de routes van een node: bij een relay-node uit diens Caddy (die heeft de certificaten). */
export async function sslStatuses(node: NodeRow, timeoutMs = 3000): Promise<{ host: string; ssl_status: string }[]> {
  if (!node.httpRelayNodeId) return call(() => daemonFor(node).routes(timeoutMs));
  const a = await rowOf(node.httpRelayNodeId);
  if (!a) return [];
  const st = await call(() => daemonFor(a).relayState(true, Math.max(timeoutMs, 8000)));
  return st.clients.find((c) => c.node_id === node.id)?.ssl ?? [];
}

// ---------- admin ----------

const notAllowed = (why: string) => new TRPCError({ code: "BAD_REQUEST", message: `RELAY_NOT_ALLOWED: ${why}` });

/** Kan `a` als relay voor `b` dienen? Gooit RELAY_NOT_ALLOWED met de reden. */
export function assertRelayCandidate(a: NodeRow | null, bId: number | null): asserts a is NodeRow {
  if (!a) throw new TRPCError({ code: "NOT_FOUND", message: "RELAY_NODE_NOT_FOUND" });
  if (a.id === bId) throw notAllowed("a node cannot relay through itself");
  if (!a.supportsDomains || a.publicPort !== 443) throw notAllowed("the relay node needs its own ports 80/443 (domain support)");
  if (a.httpRelayNodeId) throw notAllowed("the relay node itself relays through another node");
}

const isCandidate = (a: NodeRow, bId: number) => a.id !== bId && a.supportsDomains && a.publicPort === 443 && !a.httpRelayNodeId;

export const newRelaySecret = () => encrypt(randomToken(32));

async function cloudflareZoneFor(name: string): Promise<{ token: string; zoneId: string } | null> {
  for (const p of await getDb().select().from(schema.dnsProviders)) {
    const z = zoneFor(p.zones, name);
    if (z) return { token: decrypt(p.apiTokenEnc), zoneId: z.id };
  }
  return null;
}

/** Namen die naar de HTTP(S)-ingang van de node wijzen: het node-domein en de webdomeinen (incl. `*.` bij wildcard). */
async function httpNames(n: NodeRow): Promise<{ name: string; providerId: number | null | "any" }[]> {
  // Het node-domein: elke gekoppelde zone die hem dekt (zoals bij de join). Domeinen: alleen hun eigen provider.
  const out: { name: string; providerId: number | null | "any" }[] = [{ name: n.fqdn, providerId: "any" }];
  const rows = await getDb()
    .select({ d: schema.domains })
    .from(schema.domains)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.domains.serverId))
    .where(and(eq(schema.servers.nodeId, n.id), ne(schema.domains.protocol, "minecraft")))
    .orderBy(asc(schema.domains.id));
  for (const { d } of rows) {
    out.push({ name: d.hostname, providerId: d.dnsProviderId });
    if (d.wildcard) out.push({ name: `*.${d.hostname}`, providerId: d.dnsProviderId });
  }
  return out;
}

async function providerFor(name: string, providerId: number | null | "any"): Promise<{ token: string; zoneId: string } | null> {
  if (providerId === "any") return cloudflareZoneFor(name);
  if (providerId === null) return null;
  const [p] = await getDb().select().from(schema.dnsProviders).where(eq(schema.dnsProviders.id, providerId));
  const z = p ? zoneFor(p.zones, name.replace(/^\*\./, "")) : null;
  return p && z ? { token: decrypt(p.apiTokenEnc), zoneId: z.id } : null;
}

/** Records voor de HTTP(S)-ingang. apply = via de provider zetten waar dat kan; check = DNS opzoeken. */
export async function relayDnsRecords(n: NodeRow, opts: { apply: boolean; check: boolean; ip?: string | null }): Promise<RelayDnsRecord[]> {
  let ip: string | null = opts.ip ?? null;
  if (opts.ip === undefined) {
    try {
      ip = await httpIp(n);
    } catch {
      ip = null;
    }
  }
  const out: RelayDnsRecord[] = [];
  for (const { name, providerId } of (await httpNames(n)).slice(0, 50)) {
    const prov = await providerFor(name, providerId).catch(() => null);
    const rec: RelayDnsRecord = { name, type: "A", value: ip, managed: !!prov, applied: null, error: null, ok: null };
    if (opts.apply && prov && ip) {
      try {
        await setARecord(prov.token, prov.zoneId, name, ip);
        rec.applied = true;
      } catch (e) {
        rec.applied = false;
        rec.error = e instanceof CloudflareError ? e.message : "error";
      }
    }
    if (opts.check && ip && !name.startsWith("*.")) rec.ok = (await dns().a(name).catch(() => [] as string[])).includes(ip);
    out.push(rec);
  }
  return out;
}

/** admin.nodes.setHttpRelay */
export async function setHttpRelay(n: NodeRow, relayNodeId: number | null): Promise<{ node: NodeRow; dns: RelayDnsRecord[]; previous: number | null }> {
  const db = getDb();
  const previous = n.httpRelayNodeId;
  if (relayNodeId !== null) {
    if (n.isLocal) throw notAllowed("the local node runs the panel and needs its own ports 80/443");
    const a = await rowOf(relayNodeId);
    assertRelayCandidate(a, n.id);
    const [client] = await db.select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.httpRelayNodeId, n.id)).limit(1);
    if (client) throw new TRPCError({ code: "CONFLICT", message: "NODE_IS_RELAY: other nodes relay through this node; move them first" });
  }
  const changed = previous !== relayNodeId;
  const [row] = (await db
    .update(schema.nodes)
    .set(
      relayNodeId === null
        ? { httpRelayNodeId: null, relaySecretEnc: null, relayStatus: null }
        : // Via een relay ondersteunt de node domeinen en is hij op 443 bereikbaar (via de relay-node).
          { httpRelayNodeId: relayNodeId, supportsDomains: true, publicPort: 443, ...(changed || !n.relaySecretEnc ? { relaySecretEnc: newRelaySecret(), relayStatus: null } : {}) },
    )
    .where(eq(schema.nodes.id, n.id))
    .returning()) as [NodeRow];
  ipCache.delete(n.id);
  // Terug naar eigen poorten: het node-domein wijst nu nog naar de relay-node, dus niet via DNS opzoeken maar
  // het IP nemen dat het panel van de node kent (join, allocatie, NODE_PUBLIC_IP).
  let ip: string | null | undefined;
  if (relayNodeId === null) ip = n.isLocal ? (getEnv().NODE_PUBLIC_IP ?? null) : ((await knownIp(n.id, n.publicIp)) ?? null);
  const records = await relayDnsRecords(row, { apply: changed, check: false, ip });
  // Eerst de (nieuwe) relay-node, dan de oude (die laat B los), dan de node zelf (start/stopt de tunnel).
  void pokeRelay([relayNodeId, previous, n.id]);
  return { node: row, dns: records, previous };
}

const toDate = (s: string | null | undefined) => (s ? new Date(s) : null);

/** admin.nodes.relayStatus */
export async function relayStatus(n: NodeRow): Promise<NodeRelayStatus> {
  const db = getDb();
  const all = await db.select().from(schema.nodes).orderBy(asc(schema.nodes.id));
  let httpIpOut: string | null = null;
  try {
    httpIpOut = await httpIp(n);
  } catch {
    httpIpOut = null;
  }
  const rs = n.relayStatus;
  const tunnel =
    n.httpRelayNodeId && rs && rs.edgeNodeId === n.httpRelayNodeId
      ? {
          connected: rs.connected,
          latencyMs: rs.latencyMs,
          lastError: rs.lastError,
          lastErrorAt: toDate(rs.lastErrorAt),
          connectedAt: toDate(rs.connectedAt),
          reconnects: rs.reconnects,
          httpMode: rs.httpMode,
          reportedAt: new Date(rs.reportedAt),
        }
      : null;
  let edge: NodeRelayStatus["edge"] = null;
  const a = n.httpRelayNodeId ? all.find((x) => x.id === n.httpRelayNodeId) : undefined;
  if (a) {
    try {
      const st = await daemonFor(a).relayState(false, 3000);
      const c = st.clients.find((x) => x.node_id === n.id);
      edge = c ? { connected: c.connected, latencyMs: c.latency_ms ?? null, lastError: c.last_error ?? null, hosts: c.hosts } : { connected: false, latencyMs: null, lastError: "the relay node does not know this node yet", hosts: [] };
    } catch {
      edge = null;
    }
  }
  return {
    relayNodeId: n.httpRelayNodeId,
    httpIp: httpIpOut,
    tunnel,
    edge,
    dns: await relayDnsRecords(n, { apply: false, check: true }),
    candidates: n.isLocal ? [] : all.filter((x) => isCandidate(x, n.id)).map((x) => ({ id: x.id, name: x.name, fqdn: x.fqdn })),
    clients: all.filter((x) => x.httpRelayNodeId === n.id).map((x) => ({ id: x.id, name: x.name, fqdn: x.fqdn })),
    modeCommand: n.isLocal ? null : httpModeCommand(n.httpRelayNodeId ? "relay" : "direct"),
  };
}

/** Commando voor op de node: Caddy (en HTTP_MODE) omzetten; zie deploy/join/join.sh --http-mode. */
export const httpModeCommand = (mode: "relay" | "direct") => `curl -fsSL ${publicPanelUrl()}/join | sudo bash -s -- --http-mode ${mode}`;

/** POST /api/remote/relay/status: wat de node over zijn tunnel meldt. */
export async function storeRelayReport(
  n: NodeRow,
  b: { edge_node_id: number; connected: boolean; connected_at?: string | null; latency_ms?: number | null; last_error?: string | null; last_error_at?: string | null; reconnects?: number; http_mode?: "direct" | "relay" },
): Promise<void> {
  await getDb()
    .update(schema.nodes)
    .set({
      relayStatus: {
        edgeNodeId: b.edge_node_id,
        connected: b.connected,
        latencyMs: b.latency_ms ?? null,
        lastError: b.last_error?.slice(0, 500) ?? null,
        lastErrorAt: b.last_error_at ?? null,
        connectedAt: b.connected_at ?? null,
        reconnects: b.reconnects ?? 0,
        httpMode: b.http_mode ?? null,
        reportedAt: new Date().toISOString(),
      },
    })
    .where(eq(schema.nodes.id, n.id));
}
