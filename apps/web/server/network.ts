/** Minecraft-netwerk: proxy (Velocity) met backends. Zie routers/network.ts voor de procedures. */
import { isBackendTemplate, isProxyTemplate, suggestBackendName, type NetworkMember, type ServerNetwork } from "@panel/api";
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "./db";
import { nodeIp } from "./routers/domains";
import { DaemonHttpError, call, daemonFor } from "./daemon";
import { applyNetworkToml } from "./lib/velocity-toml";
import { fetchServers, type ServerBundle } from "./servers-data";

export const FORWARDING_VAR = "VELOCITY_FORWARDING";
export const SECRET_VAR = "VELOCITY_SECRET";
export const PROXY_SECRET_VAR = "VELOCITY_FORWARDING_SECRET";

export const isProxy = (b: ServerBundle) => b.server.type === "game" && isProxyTemplate(b.template.slug);
/** Backend = game-server met een bekende backend-template die de forwarding-variabelen kent. */
export const isBackend = (b: ServerBundle) =>
  b.server.type === "game" && isBackendTemplate(b.template.slug) && [FORWARDING_VAR, SECRET_VAR].every((k) => b.template.variables.some((v) => v.key === k));

/** Primaire allocation als "ip:poort"; 0.0.0.0 wordt het publieke IP van de node (null als dat onbekend is). */
export async function allocationAddress(b: ServerBundle): Promise<string | null> {
  const a = b.allocations[0];
  if (!a) return null;
  if (a.ip !== "0.0.0.0") return `${a.ip}:${a.port}`;
  try {
    return `${await nodeIp(b.node)}:${a.port}`;
  } catch {
    return null;
  }
}

/** Unieke, geldige netwerknaam per server uit de servernaam. */
export function suggestNames(servers: Array<{ uuid: string; name: string }>): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  for (const s of servers) {
    const base = suggestBackendName(s.name).slice(0, 28);
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}-${i}`;
    used.add(n);
    out.set(s.uuid, n);
  }
  return out;
}

const NONE: ServerNetwork = { role: "none", members: [], proxy: null, connectAddress: null };

/** Adres voor spelers: het minecraft-domein van de proxy, anders de allocation. */
async function connectAddress(b: ServerBundle): Promise<string | null> {
  const [d] = await getDb()
    .select({ hostname: schema.domains.hostname })
    .from(schema.domains)
    .where(and(eq(schema.domains.serverId, b.server.id), eq(schema.domains.protocol, "minecraft")))
    .orderBy(asc(schema.domains.id));
  return d?.hostname ?? (await allocationAddress(b));
}

/** Leden van een proxy, op volgorde van `try`, met hun bundels. */
export async function proxyMembers(proxyId: number) {
  const rows = await getDb().select().from(schema.networkMembers).where(eq(schema.networkMembers.proxyServerId, proxyId)).orderBy(asc(schema.networkMembers.position));
  const bundles = rows.length ? await fetchServers(inArray(schema.servers.id, rows.map((r) => r.backendServerId))) : [];
  return rows.flatMap((m) => {
    const b = bundles.find((x) => x.server.id === m.backendServerId);
    return b ? [{ m, b }] : [];
  });
}

export async function serverNetwork(b: ServerBundle): Promise<ServerNetwork> {
  if (isProxy(b)) {
    const members: NetworkMember[] = [];
    for (const { m, b: bb } of await proxyMembers(b.server.id)) {
      members.push({ serverUuid: bb.server.uuid, serverName: bb.server.name, name: m.name, isDefault: m.position === 0, address: await allocationAddress(bb) });
    }
    return { role: "proxy", members, proxy: null, connectAddress: await connectAddress(b) };
  }
  const [p] = await getDb()
    .select({ uuid: schema.servers.uuid, name: schema.servers.name })
    .from(schema.networkMembers)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.networkMembers.proxyServerId))
    .where(eq(schema.networkMembers.backendServerId, b.server.id));
  return p ? { role: "backend", members: [], proxy: p, connectAddress: null } : NONE;
}

/** Adres van een backend op het gedeelde Docker-netwerk van de proxy (containernaam + primaire poort). */
export const containerAddress = (b: ServerBundle): string | null => (b.allocations[0] ? `panel-${b.server.uuid}:${b.allocations[0].port}` : null);

/**
 * Zet het gedeelde netwerk (panel-net-<proxy>) op de node van de proxy voor de leden op die node
 * en geeft per lid (uuid) het adres voor velocity.toml: op dat netwerk de containernaam (werkt
 * ook voor een allocation op 127.0.0.1 en zonder publiek IP), anders het allocation-adres via de
 * host (leden op een andere node, of een daemon die PUT /network nog niet kent).
 * Andere daemonfouten worden doorgegeven.
 */
export async function memberAddresses(proxy: ServerBundle, members: ServerBundle[]): Promise<Map<string, string | null>> {
  const local = members.filter((b) => b.node.id === proxy.node.id && b.allocations[0]);
  let shared = false;
  try {
    await daemonFor(proxy.node).setProxyNetwork(proxy.server.uuid, local.map((b) => b.server.uuid));
    shared = true;
  } catch (e) {
    if (!(e instanceof DaemonHttpError && e.status === 404)) throw e;
  }
  const out = new Map<string, string | null>();
  for (const b of members) out.set(b.server.uuid, shared && local.includes(b) ? containerAddress(b) : await allocationAddress(b));
  return out;
}

/**
 * Schrijft de adressen van alle leden van een proxy opnieuw in velocity.toml (bijvoorbeeld nadat een
 * backend of de proxy naar een andere node is verplaatst). Een draaiende proxy krijgt `velocity reload`.
 * Geeft true als velocity.toml is bijgewerkt.
 */
export async function rewriteProxyToml(proxy: ServerBundle): Promise<boolean> {
  const members = await proxyMembers(proxy.server.id);
  const addrs = await memberAddresses(proxy, members.map((x) => x.b));
  const list: Array<{ name: string; address: string }> = [];
  for (const { m, b } of members) {
    const address = addrs.get(b.server.uuid);
    if (!address) throw new Error(`no address for ${b.server.name}`);
    list.push({ name: m.name, address });
  }
  const d = daemonFor(proxy.node);
  let toml: string;
  try {
    toml = await d.readFile(proxy.server.uuid, "/velocity.toml");
  } catch (e) {
    if (e instanceof DaemonHttpError && e.status === 404) return false;
    throw e;
  }
  await call(() => d.writeFile(proxy.server.uuid, "/velocity.toml", applyNetworkToml(toml, list)));
  // Draait de proxy, dan live herladen (geen herstart: spelers op andere servers blijven verbonden).
  try {
    if ((await d.getServer(proxy.server.uuid, 2000)).state === "online") await d.sendCommands(proxy.server.uuid, ["velocity reload"]);
  } catch {
    // niet bereikbaar: geldt bij de volgende start
  }
  return true;
}

/** Werkt velocity.toml bij van de proxy waar backend bij hoort. Geeft de uuid van die proxy, of null. */
export async function syncProxyAddresses(backend: ServerBundle): Promise<string | null> {
  const [link] = await getDb().select({ proxyId: schema.networkMembers.proxyServerId }).from(schema.networkMembers).where(eq(schema.networkMembers.backendServerId, backend.server.id));
  if (!link) return null;
  const [proxy] = await fetchServers(eq(schema.servers.id, link.proxyId));
  if (!proxy) return null;
  return (await rewriteProxyToml(proxy)) ? proxy.server.uuid : null;
}
