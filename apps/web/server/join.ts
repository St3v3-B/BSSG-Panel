/**
 * Node-join: eenmalige join-codes, het inwisselen daarvan, DNS (Cloudflare of handmatig), voortgang en afronden.
 * De codes staan alleen als SHA-256 in node_join_codes; het node-token verlaat het panel pas bij het inwisselen.
 */
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { addTxtRecord, CloudflareError, removeTxtRecord, setARecord, zoneFor } from "./lib/cloudflare";
import { decrypt, randomToken, sha256 } from "./lib/crypto";
import { dns } from "./lib/dns";
import { daemonFor } from "./daemon";
import { httpEntry, nodeIp } from "./relay";
import { parsePorts } from "./routers/admin";
import { publicPanelUrl } from "./routers/nodes";

type NodeRow = typeof schema.nodes.$inferSelect;
export type JoinOptions = NonNullable<NodeRow["joinOptions"]>;

export const JOIN_TTL_MS = 60 * 60 * 1000;
export const JOIN_STATES = ["docker", "download", "dns", "daemon", "certificate", "ready", "failed"] as const;
export const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Basisdomein: PANEL_DOMAIN zonder het eerste label (panel.example.com → example.com). */
export function baseDomain(): string {
  const parts = getEnv().PANEL_DOMAIN.split(".");
  return parts.length > 2 ? parts.slice(1).join(".") : parts.join(".");
}

export function suggestFqdn(name: string): string {
  const label = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "node";
  return `${label}.${baseDomain()}`;
}

/** Cloudflare-koppeling met een zone die de hostnaam dekt. */
export async function cloudflareFor(fqdn: string): Promise<{ token: string; zoneId: string } | null> {
  const providers = await getDb().select().from(schema.dnsProviders);
  for (const p of providers) {
    const z = zoneFor(p.zones, fqdn);
    if (z) return { token: decrypt(p.apiTokenEnc), zoneId: z.id };
  }
  return null;
}

export const joinCommand = (code: string) => `curl -fsSL ${publicPanelUrl()}/join | sudo bash -s -- ${code}`;
export const uninstallCommand = () => `curl -fsSL ${publicPanelUrl()}/join | sudo bash -s -- --uninstall`;

/** Nieuwe code (128+ bit); eerdere ongebruikte codes van de node vervallen. */
export async function issueJoinCode(nodeId: number): Promise<{ code: string; expiresAt: Date }> {
  const code = randomToken(24); // 192 bit
  const expiresAt = new Date(Date.now() + JOIN_TTL_MS);
  const db = getDb();
  await db.delete(schema.nodeJoinCodes).where(and(eq(schema.nodeJoinCodes.nodeId, nodeId), isNull(schema.nodeJoinCodes.usedAt)));
  await db.insert(schema.nodeJoinCodes).values({ nodeId, codeHash: sha256(code), expiresAt });
  return { code, expiresAt };
}

export interface JoinExchange {
  node_token: string;
  panel_url: string;
  node_domain: string;
  acme_email: string;
  daemon_port: number;
  sftp_port: number;
  supports_domains: boolean;
  public_port: number;
  dns_mode: "cloudflare" | "manual";
  /** relay: HTTP(S) via een andere node; Caddy op deze node zonder publieke poorten. */
  http_mode: "direct" | "relay";
  /** Waar node_domain naar moet wijzen: het eigen IP of dat van de relay-node. */
  dns_ip: string;
}

/** IP waar het node-domein naar moet wijzen: bij een relay het IP van de relay-node, anders het gemelde IP. */
async function joinDnsIp(node: NodeRow, ip: string | null): Promise<string | null> {
  if (!node.httpRelayNodeId) return ip;
  try {
    return await nodeIp(await httpEntry(node));
  } catch {
    return null;
  }
}

/** Eenmalig inwisselen. null = ongeldig, verlopen of al gebruikt. */
export async function exchangeJoinCode(code: string, ip: string): Promise<JoinExchange | null> {
  const db = getDb();
  const used = await db
    .update(schema.nodeJoinCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(schema.nodeJoinCodes.codeHash, sha256(code)), isNull(schema.nodeJoinCodes.usedAt), gt(schema.nodeJoinCodes.expiresAt, new Date())))
    .returning({ nodeId: schema.nodeJoinCodes.nodeId });
  if (!used[0]) return null;
  const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, used[0].nodeId));
  if (!node?.tokenEnc) return null;
  let mode: "cloudflare" | "manual" = "manual";
  let message = "join code accepted";
  const dnsIp = (await joinDnsIp(node, ip)) ?? ip;
  const cf = await cloudflareFor(node.fqdn);
  if (cf) {
    try {
      await setARecord(cf.token, cf.zoneId, node.fqdn, dnsIp);
      mode = "cloudflare";
      message = `DNS record ${node.fqdn} -> ${dnsIp} created${node.httpRelayNodeId ? " (HTTP(S) via the relay node)" : ""}`;
    } catch (e) {
      message = `Cloudflare failed (${e instanceof CloudflareError ? e.message : "error"}); create the DNS record by hand`;
    }
  }
  const options: JoinOptions = { ...(node.joinOptions ?? { allocationIp: null, allocationPorts: "", dnsMode: mode, dnsDone: false, allocationsCreated: 0 }), dnsMode: mode };
  await db.update(schema.nodes).set({ publicIp: ip, joinState: "docker", joinMessage: message, joinUpdatedAt: new Date(), joinOptions: options }).where(eq(schema.nodes.id, node.id));
  const env = getEnv();
  return {
    node_token: decrypt(node.tokenEnc),
    panel_url: publicPanelUrl(),
    node_domain: node.fqdn,
    acme_email: env.ACME_EMAIL ?? `admin@${baseDomain()}`,
    daemon_port: node.daemonPort,
    sftp_port: node.sftpPort,
    supports_domains: node.supportsDomains,
    public_port: node.publicPort,
    dns_mode: mode,
    http_mode: node.httpRelayNodeId ? "relay" : "direct",
    dns_ip: dnsIp,
  };
}

export async function reportProgress(node: NodeRow, state: (typeof JOIN_STATES)[number], message: string | null): Promise<void> {
  // Een node die al klaar is blijft klaar; voortgang gaat nooit terug.
  if (node.joinState === "ready") return;
  await getDb()
    .update(schema.nodes)
    .set({ joinState: state, joinMessage: message?.slice(0, 500) ?? null, joinUpdatedAt: new Date() })
    .where(and(eq(schema.nodes.id, node.id), sql`${schema.nodes.joinState} is distinct from 'ready'`));
}

export interface JoinStatusOut {
  state: "waiting" | (typeof JOIN_STATES)[number] | null;
  message: string | null;
  ip: string | null;
  dns: { mode: "cloudflare" | "manual"; record: { type: "A"; name: string; value: string | null }; resolvedIp: string | null; ok: boolean };
  daemonConnected: boolean;
  certificateOk: boolean;
  allocationsCreated: number;
  codeExpiresAt: Date | null;
  codeUsed: boolean;
}

/** Controleert DNS en bereikbaarheid, rondt af (allocaties) en geeft de status. */
export async function joinStatus(node: NodeRow): Promise<JoinStatusOut> {
  const db = getDb();
  const [code] = await db.select().from(schema.nodeJoinCodes).where(eq(schema.nodeJoinCodes.nodeId, node.id)).orderBy(sql`${schema.nodeJoinCodes.id} desc`).limit(1);
  const resolved = await dns().a(node.fqdn);
  const expected = await joinDnsIp(node, node.publicIp);
  const dnsOk = expected ? resolved.includes(expected) : false;
  let certificateOk = node.joinState === "ready";
  const daemonConnected = node.lastSeenAt !== null;
  if (!certificateOk && daemonConnected && node.joinState !== null && node.joinState !== "failed") {
    try {
      await daemonFor(node).system(4000);
      certificateOk = true;
    } catch {
      /* nog niet bereikbaar over https */
    }
  }
  let cur = node;
  if (certificateOk && node.joinState !== "ready") cur = (await finalizeJoin(node)) ?? node;
  return {
    state: cur.joinState as JoinStatusOut["state"],
    message: cur.joinMessage,
    ip: cur.publicIp,
    dns: {
      mode: cur.joinOptions?.dnsMode ?? "manual",
      record: { type: "A", name: cur.fqdn, value: expected },
      resolvedIp: resolved[0] ?? null,
      ok: dnsOk,
    },
    daemonConnected,
    certificateOk,
    allocationsCreated: cur.joinOptions?.allocationsCreated ?? 0,
    codeExpiresAt: code && !code.usedAt ? code.expiresAt : null,
    codeUsed: !!code?.usedAt,
  };
}

/** Eenmalig: join_state = ready en het standaard allocatiebereik aanmaken. */
export async function finalizeJoin(node: NodeRow): Promise<NodeRow | null> {
  const db = getDb();
  const [row] = await db
    .update(schema.nodes)
    .set({ joinState: "ready", joinMessage: null, joinUpdatedAt: new Date() })
    .where(and(eq(schema.nodes.id, node.id), sql`${schema.nodes.joinState} is distinct from 'ready'`))
    .returning();
  if (!row) return null;
  const o = row.joinOptions;
  const ip = o?.allocationIp ?? row.publicIp;
  let created = 0;
  if (ip && o?.allocationPorts) {
    const ports = parsePorts(o.allocationPorts);
    const ins = await db.insert(schema.allocations).values(ports.map((port) => ({ nodeId: row.id, ip, port }))).onConflictDoNothing().returning({ id: schema.allocations.id });
    created = ins.length;
  }
  const [out] = await db
    .update(schema.nodes)
    .set({ joinOptions: { ...(o ?? { allocationIp: null, allocationPorts: "", dnsMode: "manual", dnsDone: true }), allocationsCreated: created } })
    .where(eq(schema.nodes.id, row.id))
    .returning();
  return out ?? row;
}

/** DNS-01 voor het node-domein: alleen `_acme-challenge.<fqdn>` van de eigen node. */
export async function acmeDns(node: NodeRow, action: "present" | "cleanup", value: string): Promise<"ok" | "no_provider" | "forbidden"> {
  if (node.supportsDomains || node.isLocal) return "forbidden";
  const cf = await cloudflareFor(node.fqdn);
  if (!cf) return "no_provider";
  const name = `_acme-challenge.${node.fqdn}`;
  if (action === "present") await addTxtRecord(cf.token, cf.zoneId, name, value);
  else await removeTxtRecord(cf.token, cf.zoneId, name, value);
  return "ok";
}

export { parsePorts };
