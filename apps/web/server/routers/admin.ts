import { npmAlerts } from "../npm";
import { deleteUserSessions } from "../session";
import { emergencyAlerts } from "../emergency";
import { randomUUID } from "node:crypto";
import { FORWARDING_VAR, SECRET_VAR, isProxy, proxyMembers } from "../network";
import { setVariables } from "./network";
import { ALL_PERMISSIONS, parseTemplate, type Implementation, type NodeHealth, type Node as NodeOut, type AdminUser, type TemplateDetail } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, gt, ilike, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { logActivity } from "../activity";
import { dropServerDatabases } from "./databases";
import { removeServerRoutes } from "./domains";
import { transfer } from "./transfer";
import { assertNotInMaintenance, maintenanceOut } from "../node-maintenance";
import { activityPage } from "../activity-query";
import { DaemonHttpError, call, daemonFor } from "../daemon";
import { getDb, schema, type Db } from "../db";
import { getEnv } from "../env";
import { buildServerSpec, validateVariables } from "../spec";
import { imagePolicyOf, fetchServerByUuid, fetchServers, limitsOf, sleepOf, autoRestartOf, serverVariables, toDetail, toSummary, liveViews, userPublic, type ServerBundle } from "../servers-data";
import { adminImageRows, checkAllNodes } from "../image-updates";
import { getSettings } from "../settings";
import { setUpdatesEnabled, startUpgrade, updatesStatus, updatesSummary } from "../updates";
import { templateRow } from "../templates";
import { forgetServer, getNodeLive, isStale } from "../node-cache";
import { daemonCommitOf, isOutdated } from "../node-version";
import type { Ctx } from "@panel/api";

const ok = { ok: true as const };
const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: what });
const bad = (msg: string) => new TRPCError({ code: "BAD_REQUEST", message: msg });
type NodeRow = typeof schema.nodes.$inferSelect;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// ---------- nodes ----------

export function nodeOut(n: NodeRow): NodeOut {
  return {
    id: n.id,
    name: n.name,
    fqdn: n.fqdn,
    daemonPort: n.daemonPort,
    sftpPort: n.sftpPort,
    maxRamMb: n.maxRamMb,
    maxDiskMb: n.maxDiskMb,
    s3TargetId: n.s3TargetId,
    diskQuotaMode: n.diskQuotaMode,
    isLocal: n.isLocal,
    supportsDomains: n.supportsDomains,
    publicPort: n.publicPort,
    publicIp: n.publicIp,
    joinState: (n.joinState as NodeOut["joinState"]) ?? null,
    httpRelayNodeId: n.httpRelayNodeId,
    maintenance: maintenanceOut(n.maintenance),
    httpMode: n.npmSettings ? "npm" : n.httpRelayNodeId ? "relay" : "direct",
  };
}

async function serverCountByNode(): Promise<Map<number, number>> {
  const rows = await getDb().select({ nodeId: schema.servers.nodeId, n: count() }).from(schema.servers).groupBy(schema.servers.nodeId);
  return new Map(rows.map((r) => [r.nodeId, r.n]));
}

export async function nodeHealth(n: NodeRow, serverCount: number): Promise<NodeHealth> {
  const base: NodeHealth = {
    nodeId: n.id,
    online: false,
    version: n.daemonVersion,
    diskQuotaMode: n.diskQuotaMode,
    cpuCount: null,
    memoryTotalBytes: null,
    memoryUsedBytes: null,
    diskTotalBytes: null,
    diskFreeBytes: null,
    serverCount,
    error: null,
    lastSeenAt: null,
    commit: daemonCommitOf(n.daemonVersion),
  };
  base.outdated = isOutdated(base.commit ?? null);
  // Altijd uit de cache van de node-monitor; hier wacht niets op een daemon.
  const live = await getNodeLive(n.id);
  if (!live) return base;
  const lastSeenAt = live.lastSeenAt === null ? null : new Date(live.lastSeenAt);
  const s = live.system;
  const online = live.online && !isStale(live);
  return {
    ...base,
    online,
    lastSeenAt,
    version: s?.version ?? base.version,
    diskQuotaMode: s?.disk_quota_mode ?? base.diskQuotaMode,
    cpuCount: s?.cpu_count ?? null,
    memoryTotalBytes: s?.memory_total_bytes ?? null,
    memoryUsedBytes: s?.memory_used_bytes ?? null,
    diskTotalBytes: s?.disk_total_bytes ?? null,
    diskFreeBytes: s?.disk_free_bytes ?? null,
    error: online ? null : (live.error ?? "no response"),
    ...(() => {
      const commit = daemonCommitOf(s?.version ?? n.daemonVersion, s?.commit) ?? base.commit ?? null;
      return { commit, outdated: isOutdated(commit) };
    })(),
  };
}

export async function nodeById(id: number): Promise<NodeRow> {
  const [n] = await getDb().select().from(schema.nodes).where(eq(schema.nodes.id, id));
  if (!n) throw notFound("NODE_NOT_FOUND");
  return n;
}

// ---------- allocations ----------

export function parsePorts(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/.exec(part);
    if (!m) throw bad(`INVALID_PORTS: ${part}`);
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || b < a) throw bad(`INVALID_PORTS: ${part}`);
    if (b - a >= 1000 || out.size + (b - a + 1) > 1000) throw bad("TOO_MANY_PORTS: max 1000 per keer");
    for (let p = a; p <= b; p++) out.add(p);
  }
  if (!out.size) throw bad("INVALID_PORTS");
  return [...out].sort((x, y) => x - y);
}

/** Controleert allocation-ID's: bestaan, op deze node, vrij (of al van `serverId`). */
export async function checkAllocations(db: Db | Tx, ids: number[], nodeId: number, serverId: number | null) {
  if (new Set(ids).size !== ids.length) throw bad("DUPLICATE_ALLOCATION");
  if (!ids.length) return [];
  const rows = await db.select().from(schema.allocations).where(inArray(schema.allocations.id, ids));
  for (const id of ids) {
    const a = rows.find((r) => r.id === id);
    if (!a) throw bad(`ALLOCATION_NOT_FOUND: ${id}`);
    if (a.nodeId !== nodeId) throw bad(`ALLOCATION_OTHER_NODE: ${id}`);
    if (a.serverId !== null && a.serverId !== serverId) throw new TRPCError({ code: "CONFLICT", message: `ALLOCATION_IN_USE: ${id}` });
  }
  return ids.map((id) => rows.find((r) => r.id === id)!);
}

/** Wijst precies `ids` toe aan de server (eerste = primair), de rest komt vrij. */
export async function assignAllocations(tx: Tx, serverId: number, ids: number[]) {
  await tx
    .update(schema.allocations)
    .set({ serverId: null, isPrimary: false })
    .where(and(eq(schema.allocations.serverId, serverId), ids.length ? sql`${schema.allocations.id} not in ${ids}` : undefined));
  for (const [i, id] of ids.entries()) {
    const r = await tx
      .update(schema.allocations)
      .set({ serverId, isPrimary: i === 0 })
      .where(and(eq(schema.allocations.id, id), or(isNull(schema.allocations.serverId), eq(schema.allocations.serverId, serverId))))
      .returning({ id: schema.allocations.id });
    if (!r.length) throw new TRPCError({ code: "CONFLICT", message: `ALLOCATION_IN_USE: ${id}` });
  }
}

/** Verwijdert een server bij de daemon, de routes, de databases en uit de database; `log` draait vlak voor het DB-delete. */
export async function deleteServerFully(b: ServerBundle, log: (dbFailed: string[]) => Promise<void>): Promise<void> {
  // Een Velocity-proxy die verdwijnt: de backends terug naar niet-forwarding, anders zijn ze niet meer direct bereikbaar.
  if (isProxy(b)) {
    for (const { b: backend } of await proxyMembers(b.server.id)) {
      try {
        await setVariables(backend, { [FORWARDING_VAR]: "false", [SECRET_VAR]: "" });
      } catch {
        // backend of node onbereikbaar: de proxy-verwijdering gaat door
      }
    }
  }
  try {
    await daemonFor(b.node).deleteServer(b.server.uuid);
  } catch (e) {
    if (!(e instanceof DaemonHttpError && e.status === 404)) await call(() => Promise.reject(e));
  }
  await removeServerRoutes(b.server.id, b.node);
  const dbFailed = await dropServerDatabases(b.server.id);
  await log(dbFailed);
  await getDb().transaction(async (tx) => {
    await tx.update(schema.allocations).set({ serverId: null, isPrimary: false }).where(eq(schema.allocations.serverId, b.server.id));
    await tx.delete(schema.servers).where(eq(schema.servers.id, b.server.id));
  });
  await forgetServer(b.node.id, b.server.uuid);
}

// ---------- gebruikers ----------

const adminIds = alias(schema.adminDiscordIds, "admin_ids");

async function adminUsers(where: SQL | undefined, opts: { cursor?: number | null; limit?: number } = {}): Promise<AdminUser[]> {
  const serverCount = getDb()
    .select({ ownerId: schema.servers.ownerId, n: count().as("n") })
    .from(schema.servers)
    .groupBy(schema.servers.ownerId)
    .as("sc");
  let q = getDb()
    .select({ u: schema.users, admin: adminIds.discordId, servers: serverCount.n })
    .from(schema.users)
    .leftJoin(adminIds, eq(adminIds.discordId, schema.users.discordId))
    .leftJoin(serverCount, eq(serverCount.ownerId, schema.users.id))
    .where(and(where, eq(schema.users.isEmergency, false), opts.cursor ? gt(schema.users.id, opts.cursor) : undefined))
    .orderBy(asc(schema.users.id))
    .$dynamic();
  if (opts.limit) q = q.limit(opts.limit);
  const rows = await q;
  return rows.map((r) => ({
    ...userPublic(r.u),
    blocked: r.u.blocked,
    isAdmin: r.admin !== null,
    totpEnabled: r.u.totpEnabled,
    createdAt: r.u.createdAt,
    lastLoginAt: r.u.lastLoginAt,
    serverCount: Number(r.servers ?? 0),
    passwordLogin: r.u.loginUsername !== null && r.u.passwordHash !== null,
  }));
}

async function adminUser(id: number): Promise<AdminUser> {
  const [u] = await adminUsers(eq(schema.users.id, id));
  if (!u) throw notFound("USER_NOT_FOUND");
  return u;
}

// ---------- templates ----------

async function templateDetails(where: SQL | undefined): Promise<TemplateDetail[]> {
  const sc = getDb().select({ templateId: schema.servers.templateId, n: count().as("n") }).from(schema.servers).groupBy(schema.servers.templateId).as("sc");
  const rows = await getDb()
    .select({ t: schema.templates, n: sc.n })
    .from(schema.templates)
    .leftJoin(sc, eq(sc.templateId, schema.templates.id))
    .where(where)
    .orderBy(asc(schema.templates.type), asc(schema.templates.name));
  return rows.map(({ t, n }) => ({
    id: t.id,
    slug: t.slug,
    name: t.name,
    type: t.type,
    version: t.version,
    description: t.description,
    serverCount: Number(n ?? 0),
    yaml: t.sourceYaml,
    variables: t.variables.map((v) => ({ key: v.key, name: v.name, description: v.description ?? null, default: v.default, userEditable: v.user_editable, pattern: v.pattern ?? null })),
  }));
}

// ---------- helpers ----------

const uid = (ctx: Ctx) => ctx.session!.userId;

async function viewer(ctx: Ctx) {
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, uid(ctx)));
  return { id: u!.id, name: u!.name, discordId: u!.discordId };
}

async function mustServer(uuid: string): Promise<ServerBundle> {
  const b = await fetchServerByUuid(uuid);
  if (!b) throw notFound("SERVER_NOT_FOUND");
  return b;
}

/**
 * Opgeschort? Voor de andere routers (power, files, SFTP, ...): niet-admins mogen dan niet starten
 * of schrijven. Volledige admins (zie `isFullAdmin`) mogen wel.
 */
export async function isSuspended(serverId: number): Promise<boolean> {
  const [r] = await getDb().select({ at: schema.servers.suspendedAt }).from(schema.servers).where(eq(schema.servers.id, serverId));
  return !!r?.at;
}

/** Zelfde, op uuid; `null` als de server niet bestaat. */
export async function suspensionOf(uuid: string): Promise<{ reason: string | null; at: Date } | null> {
  const [r] = await getDb().select({ at: schema.servers.suspendedAt, reason: schema.servers.suspendedReason }).from(schema.servers).where(eq(schema.servers.uuid, uuid));
  return r?.at ? { reason: r.reason, at: r.at } : null;
}

const cursorNum = (c: string | null | undefined) => (c && /^\d+$/.test(c) ? Number(c) : null);

// ---------- implementatie ----------

type A = Implementation["admin"];

export const admin = {
  dashboard: (async () => {
    const db = getDb();
    const [nodes, counts, [srv], [usr], failed] = await Promise.all([
      db.select().from(schema.nodes).orderBy(asc(schema.nodes.id)),
      serverCountByNode(),
      db.select({ n: count() }).from(schema.servers),
      db.select({ n: count() }).from(schema.users).where(eq(schema.users.isEmergency, false)),
      db.select({ uuid: schema.servers.uuid, name: schema.servers.name, nodeId: schema.servers.nodeId, at: schema.servers.createdAt }).from(schema.servers).where(eq(schema.servers.status, "install_failed")),
    ]);
    const health = await Promise.all(nodes.map((n) => nodeHealth(n, counts.get(n.id) ?? 0)));
    const now = new Date();
    const alerts = [
      ...(await emergencyAlerts(now)),
      ...health
        .filter((h) => !h.online)
        .map((h) => ({ kind: "node_offline" as const, message: `Node ${nodes.find((n) => n.id === h.nodeId)?.name} is unreachable${h.error ? `: ${h.error}` : ""}`, at: now, serverUuid: null, nodeId: h.nodeId })),
      ...failed.map((f) => ({ kind: "install_failed" as const, message: `Installation of ${f.name} failed`, at: f.at, serverUuid: f.uuid, nodeId: f.nodeId })),
      ...health
        .filter((h) => h.online && h.diskTotalBytes && h.diskFreeBytes !== null && h.diskFreeBytes / h.diskTotalBytes < 0.1)
        .map((h) => ({ kind: "disk_low" as const, message: `Less than 10% disk space free on node ${nodes.find((n) => n.id === h.nodeId)?.name}`, at: now, serverUuid: null, nodeId: h.nodeId })),
      ...npmAlerts(nodes, now),
    ];
    return { nodes: health, alerts, serverCount: srv?.n ?? 0, userCount: usr?.n ?? 0 };
  }) satisfies A["dashboard"],

  imageUpdates: {
    list: async () => adminImageRows(),
    checkNow: async ({ ctx }) => {
      await checkAllNodes();
      await logActivity({ action: "admin.image.check", userId: uid(ctx), ip: ctx.ip, ctx });
      return { ok: true as const };
    },
  } satisfies A["imageUpdates"],

  nodes: {
    list: async () => (await getDb().select().from(schema.nodes).orderBy(asc(schema.nodes.id))).map(nodeOut),
    get: async ({ input }) => {
      const n = await nodeById(input.id);
      const counts = await serverCountByNode();
      return { ...nodeOut(n), health: await nodeHealth(n, counts.get(n.id) ?? 0) };
    },
  } satisfies Partial<A["nodes"]>,

  allocations: {
    list: async ({ input }) => {
      await nodeById(input.nodeId);
      const rows = await getDb()
        .select({ a: schema.allocations, uuid: schema.servers.uuid, bedrockId: schema.servers.bedrockAllocationId })
        .from(schema.allocations)
        .leftJoin(schema.servers, eq(schema.servers.id, schema.allocations.serverId))
        .where(eq(schema.allocations.nodeId, input.nodeId))
        .orderBy(asc(schema.allocations.ip), asc(schema.allocations.port));
      return rows.map(({ a, uuid, bedrockId }) => ({ id: a.id, nodeId: a.nodeId, ip: a.ip, port: a.port, serverUuid: uuid, primary: a.isPrimary, role: uuid && bedrockId === a.id ? ("bedrock" as const) : ("game" as const) }));
    },
    create: async ({ input, ctx }) => {
      await nodeById(input.nodeId);
      const ports = parsePorts(input.ports);
      const rows = await getDb()
        .insert(schema.allocations)
        .values(ports.map((port) => ({ nodeId: input.nodeId, ip: input.ip, port })))
        .onConflictDoNothing()
        .returning({ id: schema.allocations.id });
      await logActivity({ action: "admin.allocation.create", userId: uid(ctx), metadata: { nodeId: input.nodeId, ip: input.ip, ports: input.ports, created: rows.length }, ip: ctx.ip, ctx });
      return { created: rows.length };
    },
    delete: async ({ input, ctx }) => {
      const [a] = await getDb().select().from(schema.allocations).where(eq(schema.allocations.id, input.id));
      if (!a) throw notFound("ALLOCATION_NOT_FOUND");
      if (a.serverId !== null) throw new TRPCError({ code: "CONFLICT", message: "ALLOCATION_IN_USE" });
      await getDb().delete(schema.allocations).where(and(eq(schema.allocations.id, input.id), isNull(schema.allocations.serverId)));
      await logActivity({ action: "admin.allocation.delete", userId: uid(ctx), metadata: { nodeId: a.nodeId, ip: a.ip, port: a.port }, ip: ctx.ip, ctx });
      return ok;
    },
  } satisfies A["allocations"],

  servers: {
    list: async ({ input, ctx }) => {
      const cursor = cursorNum(input.cursor);
      const s = input.search?.trim();
      const where = and(
        s ? or(ilike(schema.servers.name, `%${s}%`), sql`${schema.servers.uuid}::text ilike ${`${s}%`}`) : undefined,
        cursor ? lt(schema.servers.id, cursor) : undefined,
        input.ownerId ? eq(schema.servers.ownerId, input.ownerId) : undefined,
        input.nodeId ? eq(schema.servers.nodeId, input.nodeId) : undefined,
        input.type ? eq(schema.servers.type, input.type) : undefined,
        input.status ? eq(schema.servers.status, input.status) : undefined,
        input.suspended === undefined ? undefined : input.suspended ? isNotNull(schema.servers.suspendedAt) : isNull(schema.servers.suspendedAt),
      );
      const rows = await fetchServers(where, { orderBy: "id_desc", limit: input.limit + 1 });
      const page = rows.slice(0, input.limit);
      const live = await liveViews(page);
      return { items: page.map((b) => toSummary(b, uid(ctx), live.get(b.server.uuid)?.status, live.get(b.server.uuid)?.lastSeenAt)), nextCursor: rows.length > input.limit ? String(page[page.length - 1]!.server.id) : null };
    },

    create: async ({ input, ctx }) => {
      const db = getDb();
      const [ownerRow] = await db.select().from(schema.users).where(eq(schema.users.id, input.ownerId));
      if (!ownerRow || ownerRow.isEmergency) throw bad("OWNER_NOT_FOUND");
      const node = await nodeById(input.nodeId).catch(() => {
        throw bad("NODE_NOT_FOUND");
      });
      const [template] = await db.select().from(schema.templates).where(eq(schema.templates.id, input.templateId));
      if (!template) throw bad("TEMPLATE_NOT_FOUND");
      if (template.type === "game" && input.allocationIds.length === 0) throw bad("ALLOCATION_REQUIRED");
      if (template.type === "web" && input.allocationIds.length > 0) throw bad("WEB_HAS_NO_ALLOCATIONS");
      if (template.type === "web" && !node.supportsDomains) throw bad("NODE_HAS_NO_DOMAINS: this node does not support websites");
      assertNotInMaintenance(node);
      const allocs = await checkAllocations(db, input.allocationIds, node.id, null);
      const errors = validateVariables(template.variables, input.variables, { onlyUserEditable: false });
      if (errors.length) throw bad(`INVALID_VARIABLES: ${errors.join("; ")}`);

      const uuid = randomUUID();
      const serverId = await db.transaction(async (tx) => {
        const [srv] = await tx
          .insert(schema.servers)
          .values({
            uuid,
            name: input.name.trim(),
            ownerId: ownerRow.id,
            nodeId: node.id,
            templateId: template.id,
            type: template.type,
            cpuPct: input.limits.cpuPct,
            ramMb: input.limits.ramMb,
            swapMb: input.limits.swapMb,
            diskMb: input.limits.diskMb,
            status: "installing",
          })
          .returning({ id: schema.servers.id });
        await assignAllocations(tx, srv!.id, input.allocationIds);
        const vars = Object.entries(input.variables);
        if (vars.length) await tx.insert(schema.serverVariables).values(vars.map(([key, value]) => ({ serverId: srv!.id, key, value })));
        return srv!.id;
      });

      const spec = buildServerSpec({
        uuid,
        template,
        variables: input.variables,
        limits: input.limits,
        allocations: allocs.map((a, i) => ({ ip: a.ip, port: a.port, isPrimary: i === 0 })),
        startOnInstall: input.startOnInstall,
      });
      try {
        await call(() => daemonFor(node).createServer(spec));
      } catch (e) {
        // Terugdraaien: de daemon heeft niets (of het verzoek kwam niet aan).
        await db.transaction(async (tx) => {
          await tx.update(schema.allocations).set({ serverId: null, isPrimary: false }).where(eq(schema.allocations.serverId, serverId));
          await tx.delete(schema.servers).where(eq(schema.servers.id, serverId));
        });
        throw e;
      }
      await logActivity({
        action: "admin.server.create",
        userId: uid(ctx),
        serverId,
        metadata: { serverUuid: uuid, serverName: input.name, ownerId: ownerRow.id, template: template.slug, nodeId: node.id, startOnInstall: input.startOnInstall },
        ip: ctx.ip,
      });
      const b = await mustServer(uuid);
      return toDetail(b, await viewer(ctx), [...ALL_PERMISSIONS], await serverVariables(serverId));
    },

    updateLimits: async ({ input, ctx }) => {
      const b = await mustServer(input.uuid);
      const spec = buildServerSpec({ uuid: b.server.uuid, template: b.template, variables: await serverVariables(b.server.id), limits: input.limits, allocations: b.allocations, skipInstall: true, sleep: sleepOf(b.server), autoRestart: autoRestartOf(b.server), imagePolicy: imagePolicyOf(b.server) });
      await call(() => daemonFor(b.node).updateServer(b.server.uuid, spec));
      await getDb()
        .update(schema.servers)
        .set({ cpuPct: input.limits.cpuPct, ramMb: input.limits.ramMb, swapMb: input.limits.swapMb, diskMb: input.limits.diskMb })
        .where(eq(schema.servers.id, b.server.id));
      await logActivity({ action: "admin.server.limits", userId: uid(ctx), serverId: b.server.id, metadata: { from: limitsOf(b.server), to: input.limits }, ip: ctx.ip, ctx });
      return ok;
    },

    updateOwner: async ({ input, ctx }) => {
      const b = await mustServer(input.uuid);
      const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, input.ownerId));
      if (!u || u.isEmergency) throw bad("OWNER_NOT_FOUND");
      await getDb().transaction(async (tx) => {
        await tx.update(schema.servers).set({ ownerId: u.id }).where(eq(schema.servers.id, b.server.id));
        await tx.delete(schema.subusers).where(and(eq(schema.subusers.serverId, b.server.id), eq(schema.subusers.userId, u.id)));
      });
      await logActivity({ action: "admin.server.owner", userId: uid(ctx), serverId: b.server.id, metadata: { from: b.server.ownerId, to: u.id }, ip: ctx.ip, ctx });
      return ok;
    },

    updateAllocations: async ({ input, ctx }) => {
      const b = await mustServer(input.uuid);
      if (b.server.type === "game" && input.allocationIds.length === 0) throw bad("ALLOCATION_REQUIRED");
      if (b.server.type === "web" && input.allocationIds.length > 0) throw bad("WEB_HAS_NO_ALLOCATIONS");
      const vars = await serverVariables(b.server.id);
      // De Bedrock-poort (Geyser) blijft bij de server; die schakelt de eigenaar via servers.setBedrock.
      const bedrockId = b.allocations.find((a) => a.id === b.server.bedrockAllocationId)?.id;
      const allocationIds = bedrockId !== undefined && !input.allocationIds.includes(bedrockId) ? [...input.allocationIds, bedrockId] : input.allocationIds;
      await getDb().transaction(async (tx) => {
        const allocs = await checkAllocations(tx, allocationIds, b.node.id, b.server.id);
        await assignAllocations(tx, b.server.id, allocationIds);
        const spec = buildServerSpec({
          uuid: b.server.uuid,
          template: b.template,
          variables: vars,
          limits: limitsOf(b.server),
          allocations: allocs.map((a, i) => ({ ip: a.ip, port: a.port, isPrimary: i === 0 })),
          skipInstall: true,
          sleep: sleepOf(b.server), autoRestart: autoRestartOf(b.server), imagePolicy: imagePolicyOf(b.server),
        });
        // Binnen de transactie: faalt de daemon, dan blijft de database ongewijzigd.
        await call(() => daemonFor(b.node).updateServer(b.server.uuid, spec));
      });
      await logActivity({ action: "admin.server.allocations", userId: uid(ctx), serverId: b.server.id, metadata: { from: b.allocations.map((a) => a.id), to: input.allocationIds }, ip: ctx.ip, ctx });
      return ok;
    },

    delete: async ({ input, ctx }) => {
      const b = await mustServer(input.uuid);
      await deleteServerFully(b, (dbFailed) =>
        logActivity({ action: "admin.server.delete", userId: uid(ctx), serverId: b.server.id, metadata: { serverUuid: b.server.uuid, serverName: b.server.name, ownerId: b.server.ownerId, ...(dbFailed.length ? { databasesNotDropped: dbFailed } : {}) }, ip: ctx.ip, ctx }),
      );
      return ok;
    },

    setTerminalAllowed: async ({ input, ctx }) => {
      const b = await mustServer(input.uuid);
      await getDb().update(schema.servers).set({ terminalAllowed: input.allowed }).where(eq(schema.servers.id, b.server.id));
      await logActivity({ action: "admin.server.terminal", userId: uid(ctx), serverId: b.server.id, metadata: { allowed: input.allowed }, ip: ctx.ip, ctx });
      return ok;
    },
    setDomainsAllowed: async ({ input, ctx }) => {
      const b = await mustServer(input.uuid);
      if (b.server.type === "web") throw bad("NOT_A_GAME_SERVER");
      if (input.allowed && !b.node.supportsDomains) throw bad("NODE_HAS_NO_DOMAINS: this node does not support domains");
      const db = getDb();
      if (!input.allowed) {
        // Uitzetten: bestaande domeinen en hun routes verdwijnen.
        await removeServerRoutes(b.server.id, b.node);
        await db.delete(schema.domains).where(eq(schema.domains.serverId, b.server.id));
      }
      await db.update(schema.servers).set({ domainsAllowed: input.allowed }).where(eq(schema.servers.id, b.server.id));
      await logActivity({ action: input.allowed ? "admin.server.domains_allow" : "admin.server.domains_disallow", userId: uid(ctx), serverId: b.server.id, metadata: { serverUuid: b.server.uuid }, ip: ctx.ip, ctx });
      return ok;
    },

    setSuspended: async ({ input, ctx }) => {
      const b = await mustServer(input.uuid);
      if (input.suspended) {
        // Eerst stoppen: een daemon-fout (behalve "draait niet") laat de server ongewijzigd.
        try {
          await daemonFor(b.node).power(b.server.uuid, "stop");
        } catch (e) {
          if (!(e instanceof DaemonHttpError && (e.status === 404 || e.status === 409))) await call(() => Promise.reject(e));
        }
        const reason = input.reason?.trim() || null;
        await getDb().update(schema.servers).set({ suspendedAt: new Date(), suspendedReason: reason }).where(eq(schema.servers.id, b.server.id));
        await logActivity({ action: "admin.server.suspend", userId: uid(ctx), serverId: b.server.id, metadata: { serverUuid: b.server.uuid, reason }, ip: ctx.ip, ctx });
      } else {
        await getDb().update(schema.servers).set({ suspendedAt: null, suspendedReason: null }).where(eq(schema.servers.id, b.server.id));
        await logActivity({ action: "admin.server.unsuspend", userId: uid(ctx), serverId: b.server.id, metadata: { serverUuid: b.server.uuid }, ip: ctx.ip, ctx });
      }
      return ok;
    },

    transfer: (opts) => transfer(opts),

    changeTemplate: async ({ input, ctx }) => {
      const b = await mustServer(input.uuid);
      const [tpl] = await getDb().select().from(schema.templates).where(eq(schema.templates.id, input.templateId));
      if (!tpl) throw bad("TEMPLATE_NOT_FOUND");
      if (tpl.id === b.template.id) throw bad("SAME_TEMPLATE");
      if (tpl.type !== b.server.type) throw bad("TEMPLATE_TYPE_MISMATCH");
      if (tpl.type === "web" && !b.node.supportsDomains) throw bad("NODE_HAS_NO_DOMAINS: this node does not support websites");
      // Variabelen met dezelfde key blijven (mits ze nog aan het patroon voldoen); de rest valt terug op de default.
      const old = await serverVariables(b.server.id);
      const keep: Record<string, string> = {};
      const dropped: string[] = [];
      for (const v of tpl.variables) {
        if (!(v.key in old)) continue;
        if (validateVariables([v], { [v.key]: old[v.key]! }, { onlyUserEditable: false }).length) dropped.push(v.key);
        else keep[v.key] = old[v.key]!;
      }
      const spec = buildServerSpec({ uuid: b.server.uuid, template: tpl, variables: keep, limits: limitsOf(b.server), allocations: b.allocations, skipInstall: !input.reinstall, sleep: sleepOf(b.server), autoRestart: autoRestartOf(b.server) });
      await getDb().transaction(async (tx) => {
        await tx.update(schema.servers).set({ templateId: tpl.id, ...(input.reinstall ? { status: "installing" as const } : {}) }).where(eq(schema.servers.id, b.server.id));
        await tx.delete(schema.serverVariables).where(eq(schema.serverVariables.serverId, b.server.id));
        const rows = Object.entries(keep).map(([key, value]) => ({ serverId: b.server.id, key, value }));
        if (rows.length) await tx.insert(schema.serverVariables).values(rows);
        // Binnen de transactie: faalt de daemon, dan blijft de database ongewijzigd.
        await call(() => daemonFor(b.node).updateServer(b.server.uuid, spec));
        if (input.reinstall) await call(() => daemonFor(b.node).reinstall(b.server.uuid));
      });
      await logActivity({
        action: "admin.server.template",
        userId: uid(ctx),
        serverId: b.server.id,
        metadata: { serverUuid: b.server.uuid, from: b.template.slug, to: tpl.slug, reinstall: input.reinstall, droppedVariables: dropped },
        ip: ctx.ip,
        ctx,
      });
      return ok;
    },
  } satisfies Partial<A["servers"]>,

  templates: {
    list: async () => (await templateDetails(undefined)).map(({ yaml: _y, variables: _v, ...t }) => t),
    get: async ({ input }) => {
      const [t] = await templateDetails(eq(schema.templates.id, input.id));
      if (!t) throw notFound("TEMPLATE_NOT_FOUND");
      return t;
    },
    /**
     * Let op: templates uit TEMPLATES_DIR worden bij elke start opnieuw ingelezen zodra de versie in het
     * bestand hoger is dan die in de database (zie `upsertTemplate`). Beheerderswijzigingen aan een
     * ingebouwde template worden dan overschreven; verhoog bij een eigen aanpassing dus de versie
     * boven die van het bestand, of kopieer de template onder een eigen slug.
     */
    create: async ({ input, ctx }) => {
      const r = parseTemplate(input.yaml);
      if (!r.ok) throw bad(`INVALID_TEMPLATE: ${r.errors.join("; ")}`);
      const [dup] = await getDb().select({ id: schema.templates.id }).from(schema.templates).where(eq(schema.templates.slug, r.spec.slug));
      if (dup) throw new TRPCError({ code: "CONFLICT", message: "SLUG_EXISTS" });
      const [row] = await getDb().insert(schema.templates).values(templateRow(r.spec, input.yaml)).onConflictDoNothing().returning({ id: schema.templates.id });
      if (!row) throw new TRPCError({ code: "CONFLICT", message: "SLUG_EXISTS" });
      await logActivity({ action: "admin.template.create", userId: uid(ctx), metadata: { slug: r.spec.slug, version: r.spec.version }, ip: ctx.ip, ctx });
      return (await templateDetails(eq(schema.templates.id, row.id)))[0]!;
    },
    update: async ({ input, ctx }) => {
      const [cur] = await getDb().select().from(schema.templates).where(eq(schema.templates.id, input.id));
      if (!cur) throw notFound("TEMPLATE_NOT_FOUND");
      const r = parseTemplate(input.yaml);
      if (!r.ok) throw bad(`INVALID_TEMPLATE: ${r.errors.join("; ")}`);
      if (r.spec.slug !== cur.slug) throw bad("SLUG_MISMATCH");
      if (r.spec.version < cur.version) throw bad("VERSION_LOWER");
      if (r.spec.type !== cur.type) {
        const [u] = await getDb().select({ n: count() }).from(schema.servers).where(eq(schema.servers.templateId, cur.id));
        if (u!.n > 0) throw new TRPCError({ code: "CONFLICT", message: "TEMPLATE_IN_USE" });
      }
      await getDb().update(schema.templates).set({ ...templateRow(r.spec, input.yaml), updatedAt: new Date() }).where(eq(schema.templates.id, cur.id));
      await logActivity({ action: "admin.template.update", userId: uid(ctx), metadata: { slug: cur.slug, from: cur.version, to: r.spec.version }, ip: ctx.ip, ctx });
      return (await templateDetails(eq(schema.templates.id, cur.id)))[0]!;
    },
    delete: async ({ input, ctx }) => {
      const [cur] = await getDb().select().from(schema.templates).where(eq(schema.templates.id, input.id));
      if (!cur) throw notFound("TEMPLATE_NOT_FOUND");
      const [u] = await getDb().select({ n: count() }).from(schema.servers).where(eq(schema.servers.templateId, cur.id));
      if (u!.n > 0) throw new TRPCError({ code: "CONFLICT", message: "TEMPLATE_IN_USE" });
      try {
        await getDb().delete(schema.templates).where(eq(schema.templates.id, cur.id));
      } catch {
        throw new TRPCError({ code: "CONFLICT", message: "TEMPLATE_IN_USE" }); // server aangemaakt tussen check en delete (FK restrict)
      }
      await logActivity({ action: "admin.template.delete", userId: uid(ctx), metadata: { slug: cur.slug }, ip: ctx.ip, ctx });
      return ok;
    },
    validate: async ({ input }) => {
      const r = parseTemplate(input.yaml);
      return r.ok ? { ok: true, errors: [] } : { ok: false, errors: r.errors };
    },
  } satisfies Partial<A["templates"]>,

  users: {
    list: async ({ input }) => {
      const s = input.search?.trim();
      const rows = await adminUsers(s ? or(ilike(schema.users.name, `%${s}%`), ilike(schema.users.discordId, `${s}%`)) : undefined, {
        cursor: cursorNum(input.cursor),
        limit: input.limit + 1,
      });
      const page = rows.slice(0, input.limit);
      return { items: page, nextCursor: rows.length > input.limit ? String(page[page.length - 1]!.id) : null };
    },
    get: async ({ input }) => adminUser(input.id),
    create: async ({ input, ctx }) => {
      const [u] = await getDb().insert(schema.users).values({ discordId: input.discordId }).onConflictDoNothing().returning({ id: schema.users.id });
      if (!u) throw new TRPCError({ code: "CONFLICT", message: "USER_EXISTS" });
      await logActivity({ action: "admin.user.create", userId: uid(ctx), metadata: { targetUserId: u.id, discordId: input.discordId }, ip: ctx.ip, ctx });
      return adminUser(u.id);
    },
    setBlocked: async ({ input, ctx }) => {
      const target = await adminUser(input.id);
      if (input.blocked) {
        if (target.discordId === getEnv().OWNER_DISCORD_ID) throw new TRPCError({ code: "FORBIDDEN", message: "CANNOT_BLOCK_OWNER" });
        if (target.id === uid(ctx)) throw new TRPCError({ code: "FORBIDDEN", message: "CANNOT_BLOCK_SELF" });
      }
      await getDb().transaction(async (tx) => {
        await tx.update(schema.users).set({ blocked: input.blocked }).where(eq(schema.users.id, input.id));
        if (input.blocked) await tx.delete(schema.sessions).where(eq(schema.sessions.userId, input.id));
      });
      await logActivity({ action: input.blocked ? "admin.user.block" : "admin.user.unblock", userId: uid(ctx), metadata: { targetUserId: input.id }, ip: ctx.ip, ctx });
      return ok;
    },
    revokeSessions: async ({ input, ctx }) => {
      await adminUser(input.id);
      const revoked = await deleteUserSessions(input.id);
      await logActivity({ action: "admin.user.revoke_sessions", userId: uid(ctx), metadata: { targetUserId: input.id, revoked }, ip: ctx.ip, ctx });
      return { revoked };
    },

    resetTotp: async ({ input, ctx }) => {
      await adminUser(input.id);
      await getDb().update(schema.users).set({ totpEnabled: false, totpSecretEnc: null }).where(eq(schema.users.id, input.id));
      await getDb().delete(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, input.id));
      await logActivity({ action: "admin.user.reset_totp", userId: uid(ctx), metadata: { targetUserId: input.id }, ip: ctx.ip, ctx });
      return ok;
    },
  } satisfies Partial<A["users"]>,

  admins: {
    list: async () => {
      const u = alias(schema.users, "u");
      const by = alias(schema.users, "by");
      const rows = await getDb()
        .select({ a: schema.adminDiscordIds, u, by })
        .from(schema.adminDiscordIds)
        .leftJoin(u, eq(u.discordId, schema.adminDiscordIds.discordId))
        .leftJoin(by, eq(by.id, schema.adminDiscordIds.addedBy))
        .orderBy(asc(schema.adminDiscordIds.addedAt));
      const owner = getEnv().OWNER_DISCORD_ID;
      return rows.map((r) => ({
        discordId: r.a.discordId,
        user: r.u ? userPublic(r.u) : null,
        addedBy: r.by && r.by.discordId ? userPublic(r.by) : null,
        addedAt: r.a.addedAt,
        isOwner: r.a.discordId === owner,
      }));
    },
    add: async ({ input, ctx }) => {
      const r = await getDb().insert(schema.adminDiscordIds).values({ discordId: input.discordId, addedBy: uid(ctx) }).onConflictDoNothing().returning();
      if (r.length) await logActivity({ action: "admin.admins.add", userId: uid(ctx), metadata: { discordId: input.discordId }, ip: ctx.ip, ctx });
      return ok;
    },
    remove: async ({ input, ctx }) => {
      if (input.discordId === getEnv().OWNER_DISCORD_ID) throw new TRPCError({ code: "FORBIDDEN", message: "CANNOT_REMOVE_OWNER" });
      const r = await getDb().delete(schema.adminDiscordIds).where(eq(schema.adminDiscordIds.discordId, input.discordId)).returning();
      if (!r.length) throw notFound("ADMIN_NOT_FOUND");
      await logActivity({ action: "admin.admins.remove", userId: uid(ctx), metadata: { discordId: input.discordId }, ip: ctx.ip, ctx });
      return ok;
    },
  } satisfies A["admins"],

  activity: {
    search: async ({ input }) => {
      const conds: Array<SQL | undefined> = [];
      if (input.userId) conds.push(eq(schema.activityLog.userId, input.userId));
      if (input.action) conds.push(or(eq(schema.activityLog.action, input.action), sql`${schema.activityLog.action} like ${`${input.action.replace(/[\\%_]/g, "\\$&")}.%`}`));
      if (input.serverUuid) {
        const [srv] = await getDb().select({ id: schema.servers.id }).from(schema.servers).where(eq(schema.servers.uuid, input.serverUuid));
        conds.push(or(srv ? eq(schema.activityLog.serverId, srv.id) : undefined, sql`${schema.activityLog.metadata}->>'serverUuid' = ${input.serverUuid}`));
      }
      return activityPage(and(...conds), input);
    },
  } satisfies A["activity"],

  updates: {
    status: async ({ input }) => updatesStatus(input.refresh ?? true),
    summary: async () => {
      const nodes = await getDb().select().from(schema.nodes).orderBy(asc(schema.nodes.id));
      const health = await Promise.all(nodes.map((n) => nodeHealth(n, 0)));
      const outdated = nodes.flatMap((n, i) => (health[i]!.outdated ? [{ id: n.id, name: n.name, isLocal: n.isLocal, commit: health[i]!.commit ?? null }] : []));
      return updatesSummary(outdated);
    },
    start: async ({ input, ctx }) => startUpgrade(input, { userId: uid(ctx), ip: ctx.ip }),
    setEnabled: async ({ input, ctx }) => {
      await setUpdatesEnabled(input.enabled);
      await logActivity({ action: "admin.updates.setEnabled", userId: uid(ctx), metadata: { enabled: input.enabled }, ip: ctx.ip, ctx });
      return ok;
    },
  } satisfies A["updates"],

  settings: {
    get: async () => getSettings(),
    update: async ({ input, ctx }) => {
      const pairs: Array<[string, unknown]> = [];
      if (input.panelName !== undefined) {
        const n = input.panelName.trim();
        if (!n || n.length > 60) throw bad("INVALID_PANEL_NAME");
        pairs.push(["panel_name", n]);
      }
      if (input.logoUrl !== undefined) {
        const u = input.logoUrl?.trim() ?? "";
        if (u && !/^(https?:\/\/|\/(?!\/))\S+$/i.test(u)) throw bad("INVALID_LOGO_URL");
        pairs.push(["logo_url", u]);
      }
      if (input.accentColor !== undefined) pairs.push(["accent_color", input.accentColor.toLowerCase()]);
      if (input.defaultLimits !== undefined) {
        const l = input.defaultLimits;
        if (l.cpuPct < 0 || l.ramMb < 0 || l.swapMb < 0 || l.diskMb < 0) throw bad("INVALID_LIMITS");
        pairs.push(["default_limits", l]);
      }
      if (input.imageUpdates !== undefined) {
        const iu = input.imageUpdates;
        pairs.push(["image_update_default_policy", iu.defaultPolicy], ["image_update_window", { start: iu.windowStart, end: iu.windowEnd }]);
      }
      if (input.sleepMotd !== undefined) {
        const m = input.sleepMotd;
        pairs.push(["sleep_motd_promo", m.promo.trim()], ["sleep_motd_show_logo", m.showLogoIcon], ["sleep_motd_seed_logo", m.seedLogoIcon]);
      }
      if (input.activityRetentionDays !== undefined) pairs.push(["activity_retention_days", input.activityRetentionDays]);
      if (input.terminalEnabled !== undefined) pairs.push(["terminal_enabled", input.terminalEnabled]);
      for (const [key, value] of pairs) {
        await getDb().insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
      }
      await logActivity({ action: "admin.settings.update", userId: uid(ctx), metadata: { fields: pairs.map(([k]) => k) }, ip: ctx.ip, ctx });
      return getSettings();
    },
  } satisfies Partial<A["settings"]>,
};
