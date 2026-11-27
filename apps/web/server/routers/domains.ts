/**
 * domains.*: routes via de daemon (PUT/DELETE /api/routes/{host}), DNS-check via 1.1.1.1 en
 * 8.8.8.8. Lezen: elke toegang tot de server; wijzigen en checken: domain.manage.
 */
import type { Ctx, DaemonRoute, DnsCheck, Implementation, SslStatus } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { call, DaemonHttpError, daemonFor, toTrpcError, type NodeRef } from "../daemon";
import { getDb, schema } from "../db";
import { getEnv } from "../env";
import { decrypt } from "../lib/crypto";
import { CloudflareError, setARecord, setSrvRecord, zoneFor } from "../lib/cloudflare";
import { checkDomain, checkMinecraftDomain, dns } from "../lib/dns";
import { zonesOrThrow } from "./dns-providers";
import { requireServer, type ServerAccess } from "../servers-data";

type DomainRow = typeof schema.domains.$inferSelect;
const ok = { ok: true as const };

const toDomain = (d: DomainRow, serverUuid: string) => ({
  id: d.id,
  serverUuid,
  hostname: d.hostname,
  protocol: (d.protocol === "minecraft" ? "minecraft" : "http") as "http" | "minecraft",
  targetPort: d.targetPort,
  redirectTo: d.redirectTo,
  wildcard: d.wildcard,
  dnsProviderId: d.dnsProviderId,
  sslStatus: d.sslStatus,
  dnsStatus: d.dnsStatus,
  lastCheckedAt: d.lastCheckedAt,
});

async function domainById(ctx: Ctx, id: number, need: "any" | "domain.manage") {
  const [r] = await getDb()
    .select({ d: schema.domains, uuid: schema.servers.uuid })
    .from(schema.domains)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.domains.serverId))
    .where(eq(schema.domains.id, id));
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "DOMAIN_NOT_FOUND" });
  return { d: r.d, a: await requireServer(ctx, r.uuid, need) };
}

/** Caddy leidt wildcard af uit de host: `*.<hostname>`. */
export const routeHost = (d: Pick<DomainRow, "hostname" | "wildcard">) => (d.wildcard ? `*.${d.hostname}` : d.hostname);

async function routeFor(d: Pick<DomainRow, "hostname" | "targetPort" | "redirectTo" | "wildcard" | "dnsProviderId">, serverUuid: string): Promise<DaemonRoute> {
  let dns_challenge: DaemonRoute["dns_challenge"] = null;
  if (d.wildcard) {
    const [p] = d.dnsProviderId ? await getDb().select().from(schema.dnsProviders).where(eq(schema.dnsProviders.id, d.dnsProviderId)) : [];
    if (!p) throw new TRPCError({ code: "BAD_REQUEST", message: "WILDCARD_NEEDS_DNS_PROVIDER" });
    dns_challenge = { provider: "cloudflare", api_token: decrypt(p.apiTokenEnc) };
  }
  return { host: routeHost(d), server_uuid: serverUuid, port: d.targetPort, redirect_to: d.redirectTo, wildcard: d.wildcard, dns_challenge };
}

/** IP waar de records naar moeten wijzen: NODE_PUBLIC_IP (lokale node) of het A-record van de node. */
const ipCache = new Map<number, { ip: string; until: number }>();
export async function nodeIp(node: NodeRef): Promise<string> {
  const env = getEnv();
  if (node.isLocal && env.NODE_PUBLIC_IP) return env.NODE_PUBLIC_IP;
  const c = ipCache.get(node.id);
  if (c && c.until > Date.now()) return c.ip;
  const [ip] = await dns().a(node.fqdn);
  if (!ip) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NODE_IP_UNKNOWN: zet NODE_PUBLIC_IP" });
  ipCache.set(node.id, { ip, until: Date.now() + 10 * 60_000 });
  return ip;
}
export const resetNodeIpCache = () => ipCache.clear();

const isMc = (d: Pick<DomainRow, "protocol">) => d.protocol === "minecraft";
const primaryPort = (a: ServerAccess) => a.bundle.allocations[0]?.port ?? null;

async function runCheck(d: DomainRow, a: ServerAccess): Promise<DnsCheck> {
  const ip = await nodeIp(a.bundle.node);
  const port = primaryPort(a);
  const r = isMc(d) && port ? await checkMinecraftDomain(d.hostname, ip, port) : await checkDomain(d.hostname, ip);
  const checkedAt = new Date();
  const result: DnsCheck = { domainId: d.id, records: r.records, nameservers: r.nameservers, provider: r.provider, warnings: r.warnings, checkedAt };
  await getDb()
    .update(schema.domains)
    .set({ dnsStatus: r.dnsStatus, lastCheck: { ...result, checkedAt: checkedAt.toISOString() }, lastCheckedAt: checkedAt })
    .where(eq(schema.domains.id, d.id));
  return result;
}

export const domains: Implementation["domains"] = {
  list: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "any");
    const db = getDb();
    const rows = await db.select().from(schema.domains).where(eq(schema.domains.serverId, a.bundle.server.id)).orderBy(asc(schema.domains.id));
    // SSL-status live uit de daemon; onbereikbaar → laatst bekende.
    if (rows.some((d) => !isMc(d))) {
      try {
        const routes = await daemonFor(a.bundle.node).routes(2000);
        const ssl = new Map(routes.map((r) => [r.host, r.ssl_status as SslStatus]));
        for (const d of rows.filter((d) => !isMc(d))) {
          const st = ssl.get(routeHost(d));
          if (st && st !== d.sslStatus) {
            d.sslStatus = st;
            await db.update(schema.domains).set({ sslStatus: st }).where(eq(schema.domains.id, d.id));
          }
        }
      } catch {
        /* daemon weg: DB-status */
      }
    }
    return rows.map((d) => toDomain(d, input.uuid));
  },

  add: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "domain.manage");
    const isWeb = a.bundle.server.type === "web";
    if (isWeb && input.protocol !== "http") throw new TRPCError({ code: "BAD_REQUEST", message: "PROTOCOL_NOT_ALLOWED" });
    if (!isWeb && !a.bundle.server.domainsAllowed) throw new TRPCError({ code: "FORBIDDEN", message: "DOMAINS_NOT_ALLOWED" });
    const mc = input.protocol === "minecraft";
    if (mc) {
      if (input.targetPort !== null || input.redirectTo || input.wildcard || input.hostname.startsWith("*.")) throw new TRPCError({ code: "BAD_REQUEST", message: "MINECRAFT_DOMAIN_OPTIONS" });
      if (primaryPort(a) === null) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_ALLOCATION" });
      const [existing] = await getDb().select({ id: schema.domains.id }).from(schema.domains).where(and(eq(schema.domains.serverId, a.bundle.server.id), eq(schema.domains.protocol, "minecraft")));
      if (existing) throw new TRPCError({ code: "CONFLICT", message: "MINECRAFT_DOMAIN_EXISTS" });
    } else if (!isWeb && input.targetPort === null && !input.redirectTo) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "PORT_REQUIRED" });
    }
    // "*.x" als hostnaam betekent wildcard op x; opgeslagen zonder "*.".
    const wildcard = input.wildcard || input.hostname.startsWith("*.");
    const hostname = input.hostname.toLowerCase().replace(/^\*\./, "");
    if (input.dnsProviderId) {
      const [p] = await getDb().select({ id: schema.dnsProviders.id }).from(schema.dnsProviders).where(eq(schema.dnsProviders.id, input.dnsProviderId));
      if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "DNS_PROVIDER_NOT_FOUND" });
    }
    if (input.redirectTo && input.redirectTo === hostname) throw new TRPCError({ code: "BAD_REQUEST", message: "REDIRECT_TO_SELF" });
    const [dup] = await getDb().select({ id: schema.domains.id }).from(schema.domains).where(eq(schema.domains.hostname, hostname));
    if (dup) throw new TRPCError({ code: "CONFLICT", message: "DOMAIN_TAKEN" });
    const fields = { hostname, protocol: input.protocol, targetPort: input.targetPort, redirectTo: input.redirectTo, wildcard, dnsProviderId: input.dnsProviderId };
    // Minecraft: geen Caddy-route, alleen DNS (A + SRV).
    const res = mc ? null : await call(async () => daemonFor(a.bundle.node).putRoute(await routeFor(fields, input.uuid)));
    const [row] = await getDb()
      .insert(schema.domains)
      .values({ serverId: a.bundle.server.id, ...fields, sslStatus: (res?.ssl_status as SslStatus) ?? "pending" })
      .returning();
    await logActivity({ action: "server.domain.add", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { hostname, redirectTo: input.redirectTo, protocol: input.protocol }, ip: ctx.ip, ctx });
    return toDomain(row!, input.uuid);
  },

  update: async ({ input, ctx }) => {
    const { d, a } = await domainById(ctx, input.id, "domain.manage");
    if (input.redirectTo && input.redirectTo === d.hostname) throw new TRPCError({ code: "BAD_REQUEST", message: "REDIRECT_TO_SELF" });
    if (isMc(d)) throw new TRPCError({ code: "BAD_REQUEST", message: "MINECRAFT_DOMAIN_OPTIONS" });
    if (a.bundle.server.type !== "web" && input.targetPort === null && !input.redirectTo) throw new TRPCError({ code: "BAD_REQUEST", message: "PORT_REQUIRED" });
    const next = { ...d, targetPort: input.targetPort, redirectTo: input.redirectTo };
    const res = await call(async () => daemonFor(a.bundle.node).putRoute(await routeFor(next, a.bundle.server.uuid)));
    const [row] = await getDb()
      .update(schema.domains)
      .set({ targetPort: input.targetPort, redirectTo: input.redirectTo, ...(res?.ssl_status ? { sslStatus: res.ssl_status as SslStatus } : {}) })
      .where(eq(schema.domains.id, d.id))
      .returning();
    await logActivity({ action: "server.domain.update", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { hostname: d.hostname, targetPort: input.targetPort, redirectTo: input.redirectTo }, ip: ctx.ip, ctx });
    return toDomain(row!, a.bundle.server.uuid);
  },

  remove: async ({ input, ctx }) => {
    const { d, a } = await domainById(ctx, input.id, "domain.manage");
    if (!isMc(d)) {
      try {
        await daemonFor(a.bundle.node).deleteRoute(routeHost(d));
      } catch (e) {
        if (!(e instanceof DaemonHttpError && e.status === 404)) throw toTrpcError(e);
      }
    }
    await getDb().delete(schema.domains).where(eq(schema.domains.id, d.id));
    await logActivity({ action: "server.domain.remove", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { hostname: d.hostname }, ip: ctx.ip, ctx });
    return ok;
  },

  check: async ({ input, ctx }) => {
    const { d, a } = await domainById(ctx, input.id, "domain.manage");
    return runCheck(d, a);
  },

  lastCheck: async ({ input, ctx }) => {
    const { d } = await domainById(ctx, input.id, "any");
    if (!d.lastCheck) return null;
    const c = d.lastCheck as DnsCheck & { checkedAt: string };
    return { ...c, checkedAt: new Date(c.checkedAt) };
  },

  /** Zet A-records (zonder proxy) via de gekoppelde Cloudflare-provider en checkt daarna. */
  applyDns: async ({ input, ctx }) => {
    const { d, a } = await domainById(ctx, input.id, "domain.manage");
    if (!d.dnsProviderId) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_DNS_PROVIDER" });
    const [p] = await getDb().select().from(schema.dnsProviders).where(eq(schema.dnsProviders.id, d.dnsProviderId));
    if (!p) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_DNS_PROVIDER" });
    const token = decrypt(p.apiTokenEnc);
    let zone = zoneFor(p.zones, d.hostname);
    if (!zone) {
      const zones = await zonesOrThrow(token);
      await getDb().update(schema.dnsProviders).set({ zones }).where(eq(schema.dnsProviders.id, p.id));
      zone = zoneFor(zones, d.hostname);
    }
    if (!zone) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "ZONE_NOT_FOUND" });
    const ip = await nodeIp(a.bundle.node);
    const names = d.wildcard ? [d.hostname, `*.${d.hostname}`] : [d.hostname];
    const changes: Record<string, unknown> = {};
    try {
      for (const n of names) changes[n] = await setARecord(token, zone.id, n, ip);
      const port = primaryPort(a);
      if (isMc(d) && port) changes[`_minecraft._tcp.${d.hostname}`] = await setSrvRecord(token, zone.id, `_minecraft._tcp.${d.hostname}`, port, d.hostname);
    } catch (e) {
      if (e instanceof CloudflareError) throw new TRPCError({ code: "BAD_GATEWAY", message: `CLOUDFLARE_ERROR: ${e.message}` });
      throw e;
    }
    await logActivity({ action: "server.domain.apply_dns", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { hostname: d.hostname, zone: zone.name, ip, changes }, ip: ctx.ip, ctx });
    return runCheck(d, a);
  },

  target: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "any");
    return { ip: await nodeIp(a.bundle.node), nodeFqdn: a.bundle.node.fqdn };
  },
};

/** Bij het verwijderen van een server: alle routes weg (best effort). */
export async function removeServerRoutes(serverId: number, node: NodeRef): Promise<void> {
  const rows = await getDb().select().from(schema.domains).where(eq(schema.domains.serverId, serverId));
  for (const d of rows.filter((d) => !isMc(d))) await daemonFor(node).deleteRoute(routeHost(d)).catch(() => {});
}
