/** Quota's per gebruiker: zelf servers maken/wijzigen/verwijderen binnen het quotum, en het beheer ervan door admins. */
import { randomUUID } from "node:crypto";
import { ALL_PERMISSIONS, type Implementation, type QuotaInput, type QuotaUsage } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { logActivity } from "../activity";
import { forbidApiKey } from "../apikey";
import { call, daemonFor } from "../daemon";
import { getDb, schema, type Db } from "../db";
import { buildServerSpec, validateVariables } from "../spec";
import { fetchServerByUuid, imagePolicyOf, requireServer, serverVariables, toDetail, userPublic } from "../servers-data";
import { deleteServerFully } from "./admin";
import type { Ctx } from "@panel/api";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type QuotaRow = typeof schema.userQuotas.$inferSelect;
const ok = { ok: true as const };
const uid = (ctx: Ctx) => ctx.session!.userId;
const bad = (m: string) => new TRPCError({ code: "BAD_REQUEST", message: m });

export const quotaOf = (r: QuotaRow): QuotaInput => ({
  maxRamMb: r.maxRamMb,
  maxDiskMb: r.maxDiskMb,
  maxCpuPct: r.maxCpuPct,
  maxServers: r.maxServers,
  maxDatabases: r.maxDatabases,
  templateIds: r.templateIds,
  nodeIds: r.nodeIds,
  maxPortsPerServer: r.maxPortsPerServer,
});

/** Verbruik (som van limieten van alle eigen servers, aantal servers en databases) voor meerdere gebruikers. */
export async function usageFor(db: Db | Tx, userIds: number[]): Promise<Map<number, QuotaUsage>> {
  const out = new Map<number, QuotaUsage>(userIds.map((i) => [i, { ramMb: 0, diskMb: 0, cpuPct: 0, servers: 0, databases: 0 }]));
  if (!userIds.length) return out;
  const srv = await db
    .select({
      owner: schema.servers.ownerId,
      ram: sql<number>`coalesce(sum(${schema.servers.ramMb}), 0)::int`,
      disk: sql<number>`coalesce(sum(${schema.servers.diskMb}), 0)::int`,
      cpu: sql<number>`coalesce(sum(${schema.servers.cpuPct}), 0)::int`,
      n: count(),
    })
    .from(schema.servers)
    .where(inArray(schema.servers.ownerId, userIds))
    .groupBy(schema.servers.ownerId);
  for (const r of srv) Object.assign(out.get(r.owner)!, { ramMb: r.ram, diskMb: r.disk, cpuPct: r.cpu, servers: r.n });
  const dbs = await db
    .select({ owner: schema.servers.ownerId, n: count() })
    .from(schema.databases)
    .innerJoin(schema.servers, eq(schema.servers.id, schema.databases.serverId))
    .where(inArray(schema.servers.ownerId, userIds))
    .groupBy(schema.servers.ownerId);
  for (const r of dbs) out.get(r.owner)!.databases = r.n;
  return out;
}

/** Vergrendelt de quotumrij van de gebruiker (serialiseert alle quotumwijzigingen van die gebruiker). */
export async function lockQuota(tx: Tx, userId: number): Promise<QuotaRow | null> {
  const [q] = await tx.select().from(schema.userQuotas).where(eq(schema.userQuotas.userId, userId)).for("update");
  return q ?? null;
}

const exceeded = (what: string) => new TRPCError({ code: "PRECONDITION_FAILED", message: `QUOTA_EXCEEDED: ${what}` });

/** Controleert nieuwe totalen tegen het quotum; een resource die niet groeit mag altijd. */
function checkLimits(q: QuotaRow, used: QuotaUsage, next: { ramMb: number; diskMb: number; cpuPct: number }, prev = { ramMb: 0, diskMb: 0, cpuPct: 0 }) {
  if (next.ramMb > prev.ramMb && used.ramMb + next.ramMb > q.maxRamMb) throw exceeded("ram");
  if (next.diskMb > prev.diskMb && used.diskMb + next.diskMb > q.maxDiskMb) throw exceeded("disk");
  if (next.cpuPct > prev.cpuPct && used.cpuPct + next.cpuPct > q.maxCpuPct) throw exceeded("cpu");
}

/** Voor databases.create: telt de database mee en reserveert (binnen de quotumlock) de rij. */
export async function reserveDatabase(ownerId: number, insert: (tx: Tx) => Promise<typeof schema.databases.$inferSelect>): Promise<typeof schema.databases.$inferSelect> {
  return getDb().transaction(async (tx) => {
    const q = await lockQuota(tx, ownerId);
    if (q) {
      const used = (await usageFor(tx, [ownerId])).get(ownerId)!;
      if (used.databases + 1 > q.maxDatabases) throw exceeded("databases");
    }
    return insert(tx);
  });
}

export const quotaAccount: Pick<Implementation["account"], "quota"> = {
  quota: async ({ ctx }) => {
    const db = getDb();
    const [q] = await db.select().from(schema.userQuotas).where(eq(schema.userQuotas.userId, uid(ctx)));
    if (!q) return null;
    const [templates, nodes, usage] = await Promise.all([
      db.select({ id: schema.templates.id, name: schema.templates.name, type: schema.templates.type }).from(schema.templates).orderBy(asc(schema.templates.type), asc(schema.templates.name)),
      db.select({ id: schema.nodes.id, name: schema.nodes.name, supportsDomains: schema.nodes.supportsDomains }).from(schema.nodes).orderBy(asc(schema.nodes.id)),
      usageFor(db, [uid(ctx)]),
    ]);
    return {
      quota: quotaOf(q),
      usage: usage.get(uid(ctx))!,
      templates: templates.filter((t) => !q.templateIds || q.templateIds.includes(t.id)),
      nodes: nodes.filter((n) => !q.nodeIds || q.nodeIds.includes(n.id)),
    };
  },
};

export const quotaServers: Pick<Implementation["servers"], "create" | "updateOwnLimits" | "deleteOwn"> = {
  create: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const db = getDb();
    const userId = uid(ctx);
    const [template] = await db.select().from(schema.templates).where(eq(schema.templates.id, input.templateId));
    const [node] = await db.select().from(schema.nodes).where(eq(schema.nodes.id, input.nodeId));
    if (!template) throw bad("TEMPLATE_NOT_FOUND");
    if (!node) throw bad("NODE_NOT_FOUND");
    if (template.type === "web" && !node.supportsDomains) throw bad("NODE_HAS_NO_DOMAINS: this node does not support websites");
    const errors = validateVariables(template.variables, input.variables, { onlyUserEditable: true });
    if (errors.length) throw bad(`INVALID_VARIABLES: ${errors.join("; ")}`);
    const name = input.name.trim();
    if (!name) throw bad("NAME_EMPTY");
    const limits = { ...input.limits, swapMb: 0 };
    const uuid = randomUUID();
    const wanted = template.type === "game" ? input.ports : 0;

    const { serverId, allocs } = await db.transaction(async (tx) => {
      const q = await lockQuota(tx, userId);
      if (!q) throw new TRPCError({ code: "FORBIDDEN", message: "NO_QUOTA" });
      if (q.templateIds && !q.templateIds.includes(template.id)) throw new TRPCError({ code: "FORBIDDEN", message: "TEMPLATE_NOT_ALLOWED" });
      if (q.nodeIds && !q.nodeIds.includes(node.id)) throw new TRPCError({ code: "FORBIDDEN", message: "NODE_NOT_ALLOWED" });
      if (q.maxPortsPerServer !== null && wanted > q.maxPortsPerServer) throw exceeded("ports");
      const used = (await usageFor(tx, [userId])).get(userId)!;
      if (used.servers + 1 > q.maxServers) throw exceeded("servers");
      checkLimits(q, used, limits);
      let picked: Array<typeof schema.allocations.$inferSelect> = [];
      if (wanted) {
        picked = await tx
          .select()
          .from(schema.allocations)
          .where(and(eq(schema.allocations.nodeId, node.id), isNull(schema.allocations.serverId)))
          .orderBy(asc(schema.allocations.port), asc(schema.allocations.id))
          .limit(wanted)
          .for("update", { skipLocked: true });
        if (picked.length < wanted) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_FREE_ALLOCATIONS" });
      }
      const [srv] = await tx
        .insert(schema.servers)
        .values({ uuid, name, ownerId: userId, nodeId: node.id, templateId: template.id, type: template.type, cpuPct: limits.cpuPct, ramMb: limits.ramMb, swapMb: 0, diskMb: limits.diskMb, status: "installing" })
        .returning({ id: schema.servers.id });
      for (const [i, a] of picked.entries()) await tx.update(schema.allocations).set({ serverId: srv!.id, isPrimary: i === 0 }).where(eq(schema.allocations.id, a.id));
      const vars = Object.entries(input.variables);
      if (vars.length) await tx.insert(schema.serverVariables).values(vars.map(([key, value]) => ({ serverId: srv!.id, key, value })));
      return { serverId: srv!.id, allocs: picked };
    });

    const spec = buildServerSpec({ uuid, template, variables: input.variables, limits, allocations: allocs.map((a, i) => ({ ip: a.ip, port: a.port, isPrimary: i === 0 })), startOnInstall: true });
    try {
      await call(() => daemonFor(node).createServer(spec));
    } catch (e) {
      await db.transaction(async (tx) => {
        await tx.update(schema.allocations).set({ serverId: null, isPrimary: false }).where(eq(schema.allocations.serverId, serverId));
        await tx.delete(schema.servers).where(eq(schema.servers.id, serverId));
      });
      throw e;
    }
    await logActivity({
      action: "server.create",
      userId,
      serverId,
      metadata: { serverUuid: uuid, serverName: name, template: template.slug, nodeId: node.id, limits, ports: allocs.map((a) => a.port) },
      ip: ctx.ip,
      ctx,
    });
    const b = (await fetchServerByUuid(uuid))!;
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
    return toDetail(b, { id: u!.id, name: u!.name, discordId: u!.discordId }, [...ALL_PERMISSIONS], await serverVariables(serverId));
  },

  updateOwnLimits: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const b = a.bundle;
    if (b.server.ownerId !== uid(ctx)) throw new TRPCError({ code: "FORBIDDEN", message: "OWNER_ONLY" });
    const next = { ...input.limits, swapMb: b.server.swapMb };
    const vars = await serverVariables(b.server.id);
    await getDb().transaction(async (tx) => {
      const q = await lockQuota(tx, b.server.ownerId);
      if (!q) throw new TRPCError({ code: "FORBIDDEN", message: "NO_QUOTA" });
      const total = (await usageFor(tx, [b.server.ownerId])).get(b.server.ownerId)!;
      const prev = { ramMb: b.server.ramMb, diskMb: b.server.diskMb, cpuPct: b.server.cpuPct };
      const others = { ...total, ramMb: total.ramMb - prev.ramMb, diskMb: total.diskMb - prev.diskMb, cpuPct: total.cpuPct - prev.cpuPct };
      checkLimits(q, others, next, prev);
      const spec = buildServerSpec({ uuid: b.server.uuid, template: b.template, variables: vars, limits: next, allocations: b.allocations, skipInstall: true, sleep: { enabled: b.server.sleepEnabled, idleMinutes: b.server.sleepIdleMinutes, name: b.server.name }, autoRestart: { enabled: b.server.autoRestart, max: b.server.autoRestartMax }, imagePolicy: imagePolicyOf(b.server) });
      await call(() => daemonFor(b.node).updateServer(b.server.uuid, spec));
      await tx.update(schema.servers).set({ cpuPct: next.cpuPct, ramMb: next.ramMb, diskMb: next.diskMb }).where(eq(schema.servers.id, b.server.id));
    });
    await logActivity({ action: "server.limits", userId: uid(ctx), serverId: b.server.id, metadata: { from: { cpuPct: b.server.cpuPct, ramMb: b.server.ramMb, diskMb: b.server.diskMb }, to: input.limits }, ip: ctx.ip, ctx });
    return ok;
  },

  deleteOwn: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const a = await requireServer(ctx, input.uuid, "owner", { mutates: true });
    const b = a.bundle;
    if (b.server.ownerId !== uid(ctx)) throw new TRPCError({ code: "FORBIDDEN", message: "OWNER_ONLY" });
    if (input.confirmName !== b.server.name) throw bad("NAME_MISMATCH");
    await deleteServerFully(b, (dbFailed) =>
      logActivity({ action: "server.delete", userId: uid(ctx), serverId: b.server.id, metadata: { serverUuid: b.server.uuid, serverName: b.server.name, ...(dbFailed.length ? { databasesNotDropped: dbFailed } : {}) }, ip: ctx.ip, ctx }),
    );
    return ok;
  },
};

export const quotaAdmin = {
  users: {
    getQuota: async ({ input }) => {
      const [q] = await getDb().select().from(schema.userQuotas).where(eq(schema.userQuotas.userId, input.id));
      return q ? quotaOf(q) : null;
    },
    setQuota: async ({ input, ctx }) => {
      const { id, ...q } = input;
      const db = getDb();
      const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
      if (!u || u.isEmergency) throw new TRPCError({ code: "NOT_FOUND", message: "USER_NOT_FOUND" });
      for (const [ids, table, label] of [[q.templateIds, schema.templates, "TEMPLATE"], [q.nodeIds, schema.nodes, "NODE"]] as const) {
        if (!ids?.length) continue;
        const found = await db.select({ id: table.id }).from(table).where(inArray(table.id, ids));
        if (found.length !== new Set(ids).size) throw bad(`${label}_NOT_FOUND`);
      }
      const [prev] = await db.select().from(schema.userQuotas).where(eq(schema.userQuotas.userId, id));
      await db
        .insert(schema.userQuotas)
        .values({ userId: id, ...q })
        .onConflictDoUpdate({ target: schema.userQuotas.userId, set: { ...q, updatedAt: new Date() } });
      await logActivity({ action: "admin.user.quota.set", userId: uid(ctx), metadata: { targetUserId: id, from: prev ? quotaOf(prev) : null, to: q }, ip: ctx.ip, ctx });
      return ok;
    },
    clearQuota: async ({ input, ctx }) => {
      const deleted = await getDb().delete(schema.userQuotas).where(eq(schema.userQuotas.userId, input.id)).returning({ id: schema.userQuotas.userId });
      if (deleted.length) await logActivity({ action: "admin.user.quota.clear", userId: uid(ctx), metadata: { targetUserId: input.id }, ip: ctx.ip, ctx });
      return ok;
    },
  } satisfies Partial<Implementation["admin"]["users"]>,
  quotas: {
    usage: async ({ input }) => {
      const db = getDb();
      const cursor = input.cursor && /^\d+$/.test(input.cursor) ? Number(input.cursor) : null;
      const hasServers = sql`exists (select 1 from ${schema.servers} where ${schema.servers.ownerId} = ${schema.users.id})`;
      const rows = await db
        .select({ u: schema.users, q: schema.userQuotas })
        .from(schema.users)
        .leftJoin(schema.userQuotas, eq(schema.userQuotas.userId, schema.users.id))
        .where(and(eq(schema.users.isEmergency, false), or(sql`${schema.userQuotas.userId} is not null`, hasServers), cursor ? gt(schema.users.id, cursor) : undefined))
        .orderBy(asc(schema.users.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const usage = await usageFor(db, page.map((r) => r.u.id));
      return {
        items: page.map((r) => ({ user: userPublic(r.u), quota: r.q ? quotaOf(r.q) : null, usage: usage.get(r.u.id)! })),
        nextCursor: rows.length > input.limit ? String(page[page.length - 1]!.u.id) : null,
      };
    },
  } satisfies Implementation["admin"]["quotas"],
};
