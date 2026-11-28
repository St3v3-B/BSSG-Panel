/** databases.* (vereist database.manage) en admin.databaseHosts.*. */
import type { Implementation } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, count, eq, isNull, or } from "drizzle-orm";
import { logActivity } from "../activity";
import { getDb, schema } from "../db";
import { decrypt, encrypt, randomToken } from "../lib/crypto";
import { createDatabase, dropDatabase, setPassword, testHost } from "../lib/mariadb";
import { apiKeyOf } from "../apikey";
import { isFullAdmin, requireServer, type ServerAccess } from "../servers-data";
import { issueToken, pmaAccess, pmaEnabled } from "../pma";
import { getEnv } from "../env";
import { reserveDatabase } from "./quotas";
import type { Ctx } from "@panel/api";

type HostRow = typeof schema.databaseHosts.$inferSelect;
type DbRow = typeof schema.databases.$inferSelect;

const ok = { ok: true as const };
const newPassword = () => randomToken(18);

const toDatabase = (d: DbRow, h: HostRow, serverUuid: string) => ({
  id: d.id,
  serverUuid,
  hostId: h.id,
  hostName: h.name,
  host: h.host,
  port: h.port,
  name: d.name,
  username: d.username,
  password: decrypt(d.passwordEnc),
  adminerUrl: null,
});

const mariaError = (e: unknown) => new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `DATABASE_HOST_ERROR: ${(e as Error).message?.slice(0, 300)}`, cause: e });

/** Database op id met host en servercontrole (database.manage). */
async function databaseById(ctx: Ctx, id: number, mutates = false) {
  const [r] = await getDb()
    .select({ d: schema.databases, h: schema.databaseHosts, uuid: schema.servers.uuid })
    .from(schema.databases)
    .innerJoin(schema.databaseHosts, eq(schema.databaseHosts.id, schema.databases.hostId))
    .innerJoin(schema.servers, eq(schema.servers.id, schema.databases.serverId))
    .where(eq(schema.databases.id, id));
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "DATABASE_NOT_FOUND" });
  const a = await requireServer(ctx, r.uuid, "database.manage", { mutates });
  return { ...r, a };
}

/**
 * Standaardhost: de (daemon-beheerde) MariaDB van de node van de server, anders een andere host op die node,
 * anders `local`, anders een host zonder node. Zo hoort de database altijd bij de node waar de site draait.
 */
export async function defaultHost(nodeId: number): Promise<HostRow> {
  const hosts = await getDb()
    .select()
    .from(schema.databaseHosts)
    .where(or(eq(schema.databaseHosts.name, "local"), eq(schema.databaseHosts.nodeId, nodeId), isNull(schema.databaseHosts.nodeId)))
    .orderBy(asc(schema.databaseHosts.id));
  const onNode = hosts.filter((x) => x.nodeId === nodeId);
  const h = onNode.find((x) => x.daemonManaged) ?? onNode[0] ?? hosts.find((x) => x.name === "local") ?? hosts[0];
  if (!h) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "NO_DATABASE_HOST" });
  return h;
}

/** Creates a database + user on a host and records it (shared by `databases.create` and the app installer). */
export async function createServerDatabase(ctx: Ctx, a: ServerAccess, uuid: string, baseName: string, hostId: number | null) {
  let host: HostRow;
  if (hostId) {
    const [h] = await getDb().select().from(schema.databaseHosts).where(eq(schema.databaseHosts.id, hostId));
    if (!h) throw new TRPCError({ code: "NOT_FOUND", message: "DATABASE_HOST_NOT_FOUND" });
    host = h;
  } else host = await defaultHost(a.bundle.node.id);
  const short = uuid.slice(0, 8);
  const name = `s${short}_${baseName}`;
  const username = `u${short}_${randomToken(6).replace(/[^A-Za-z0-9]/g, "x").slice(0, 7)}`;
  const password = newPassword();
  const [dup] = await getDb().select({ id: schema.databases.id }).from(schema.databases).where(and(eq(schema.databases.hostId, host.id), eq(schema.databases.name, name)));
  if (dup) throw new TRPCError({ code: "CONFLICT", message: "DATABASE_EXISTS" });
  // Eerst de rij reserveren (binnen de quotumlock), dan pas de database aanmaken; bij een fout weer weg.
  const bundle = a.bundle;
  const insert = (tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0]) =>
    tx
      .insert(schema.databases)
      .values({ serverId: bundle.server.id, hostId: host.id, name, username, passwordEnc: encrypt(password) })
      .returning()
      .then((r) => r[0]!);
  // Admins omzeilen het quotum.
  const row = await (isFullAdmin(ctx) ? getDb().transaction(insert) : reserveDatabase(bundle.server.ownerId, insert, bundle.server.id));
  try {
    await createDatabase(host, name, username, password);
  } catch (e) {
    await getDb().delete(schema.databases).where(eq(schema.databases.id, row.id));
    if ((e as { errno?: number }).errno === 1007) throw new TRPCError({ code: "CONFLICT", message: "DATABASE_EXISTS" });
    throw mariaError(e);
  }
  await logActivity({ action: "server.database.create", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { name, hostId: host.id }, ip: ctx.ip, ctx });
  return toDatabase(row, host, uuid);
}

export async function removeServerDatabase(id: number): Promise<void> {
  const [r] = await getDb().select({ d: schema.databases, h: schema.databaseHosts }).from(schema.databases).innerJoin(schema.databaseHosts, eq(schema.databaseHosts.id, schema.databases.hostId)).where(eq(schema.databases.id, id));
  if (!r) return;
  await dropDatabase(r.h, r.d.name, r.d.username);
  await getDb().delete(schema.databases).where(eq(schema.databases.id, id));
}

export const databases: Implementation["databases"] = {
  list: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "database.manage");
    const rows = await getDb()
      .select({ d: schema.databases, h: schema.databaseHosts })
      .from(schema.databases)
      .innerJoin(schema.databaseHosts, eq(schema.databaseHosts.id, schema.databases.hostId))
      .where(eq(schema.databases.serverId, a.bundle.server.id))
      .orderBy(asc(schema.databases.id));
    return rows.map((r) => toDatabase(r.d, r.h, input.uuid));
  },

  create: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "database.manage", { mutates: true });
    return createServerDatabase(ctx, a, input.uuid, input.name, input.hostId);
  },

  resetPassword: async ({ input, ctx }) => {
    const r = await databaseById(ctx, input.id, true);
    const password = newPassword();
    try {
      await setPassword(r.h, r.d.username, password, r.d.name);
    } catch (e) {
      throw mariaError(e);
    }
    const [row] = await getDb().update(schema.databases).set({ passwordEnc: encrypt(password) }).where(eq(schema.databases.id, r.d.id)).returning();
    await logActivity({ action: "server.database.reset_password", userId: ctx.session!.userId, serverId: r.a.bundle.server.id, metadata: { name: r.d.name }, ip: ctx.ip, ctx });
    return toDatabase(row!, r.h, r.uuid);
  },

  delete: async ({ input, ctx }) => {
    const r = await databaseById(ctx, input.id, true);
    try {
      await dropDatabase(r.h, r.d.name, r.d.username);
    } catch (e) {
      throw mariaError(e);
    }
    await getDb().delete(schema.databases).where(eq(schema.databases.id, r.d.id));
    await logActivity({ action: "server.database.delete", userId: ctx.session!.userId, serverId: r.a.bundle.server.id, metadata: { name: r.d.name }, ip: ctx.ip, ctx });
    return ok;
  },

  phpMyAdminInfo: async ({ ctx }) => {
    if (!pmaEnabled()) return { visible: false, hasRemoteDatabases: false };
    const admin = isFullAdmin(ctx);
    const a = await pmaAccess(ctx.session!.userId, admin);
    return { visible: admin || a.local.length > 0, hasRemoteDatabases: a.remote > 0 };
  },

  phpMyAdminUrl: async ({ ctx }) => {
    if (!pmaEnabled()) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "PHPMYADMIN_DISABLED" });
    // Een API-sleutel krijgt nooit directe databasetoegang via phpMyAdmin.
    if (apiKeyOf(ctx)) throw new TRPCError({ code: "FORBIDDEN", message: "NO_ACCESS" });
    const admin = isFullAdmin(ctx);
    const userId = ctx.session!.userId;
    if (!admin && (await pmaAccess(userId, false)).local.length === 0) throw new TRPCError({ code: "FORBIDDEN", message: "NO_DATABASES" });
    const token = await issueToken({ userId, admin });
    await logActivity({ action: "account.phpmyadmin.open", userId, metadata: {}, ip: ctx.ip, ctx });
    return { url: `/phpmyadmin/signon.php?token=${encodeURIComponent(token)}` };
  },
};

// ---------- admin ----------

async function hostWithCount(id: number) {
  const [r] = await getDb()
    .select({ h: schema.databaseHosts, n: count(schema.databases.id) })
    .from(schema.databaseHosts)
    .leftJoin(schema.databases, eq(schema.databases.hostId, schema.databaseHosts.id))
    .where(eq(schema.databaseHosts.id, id))
    .groupBy(schema.databaseHosts.id);
  if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "DATABASE_HOST_NOT_FOUND" });
  return toHost(r.h, r.n);
}

const toHost = (h: HostRow, n: number) => ({ id: h.id, name: h.name, host: h.host, port: h.port, adminUser: h.adminUser, nodeId: h.nodeId, daemonManaged: h.daemonManaged, databaseCount: Number(n) });
const uid = (ctx: Ctx) => ctx.session!.userId;

export const databaseHosts: Implementation["admin"]["databaseHosts"] = {
  list: async () => {
    const rows = await getDb()
      .select({ h: schema.databaseHosts, n: count(schema.databases.id) })
      .from(schema.databaseHosts)
      .leftJoin(schema.databases, eq(schema.databases.hostId, schema.databaseHosts.id))
      .groupBy(schema.databaseHosts.id)
      .orderBy(asc(schema.databaseHosts.id));
    return rows.map((r) => toHost(r.h, r.n));
  },

  create: async ({ input, ctx }) => {
    if (input.nodeId) {
      const [n] = await getDb().select({ id: schema.nodes.id }).from(schema.nodes).where(eq(schema.nodes.id, input.nodeId));
      if (!n) throw new TRPCError({ code: "NOT_FOUND", message: "NODE_NOT_FOUND" });
    }
    const [h] = await getDb()
      .insert(schema.databaseHosts)
      .values({ name: input.name, host: input.host, port: input.port, adminUser: input.adminUser, adminPasswordEnc: encrypt(input.adminPassword), nodeId: input.nodeId })
      .returning();
    await logActivity({ action: "admin.database_host.create", userId: uid(ctx), metadata: { id: h!.id, name: input.name }, ip: ctx.ip, ctx });
    return toHost(h!, 0);
  },

  update: async ({ input, ctx }) => {
    const { id, adminPassword, ...rest } = input;
    const set: Partial<typeof schema.databaseHosts.$inferInsert> = { ...rest };
    if (adminPassword) set.adminPasswordEnc = encrypt(adminPassword);
    if (Object.keys(set).length) {
      const r = await getDb().update(schema.databaseHosts).set(set).where(eq(schema.databaseHosts.id, id)).returning();
      if (!r.length) throw new TRPCError({ code: "NOT_FOUND", message: "DATABASE_HOST_NOT_FOUND" });
    }
    await logActivity({ action: "admin.database_host.update", userId: uid(ctx), metadata: { id, fields: Object.keys(input).filter((k) => k !== "id") }, ip: ctx.ip, ctx });
    return hostWithCount(id);
  },

  delete: async ({ input, ctx }) => {
    const h = await hostWithCount(input.id);
    if (h.databaseCount > 0) throw new TRPCError({ code: "CONFLICT", message: "DATABASE_HOST_IN_USE" });
    await getDb().delete(schema.databaseHosts).where(eq(schema.databaseHosts.id, input.id));
    await logActivity({ action: "admin.database_host.delete", userId: uid(ctx), metadata: { id: input.id, name: h.name }, ip: ctx.ip, ctx });
    return ok;
  },

  test: async ({ input }) => {
    const [h] = await getDb().select().from(schema.databaseHosts).where(eq(schema.databaseHosts.id, input.id));
    if (!h) throw new TRPCError({ code: "NOT_FOUND", message: "DATABASE_HOST_NOT_FOUND" });
    return testHost(h);
  },
};

/** Bij het verwijderen van een server: databases en gebruikers op de hosts weghalen (best effort). */
export async function dropServerDatabases(serverId: number): Promise<string[]> {
  const rows = await getDb()
    .select({ d: schema.databases, h: schema.databaseHosts })
    .from(schema.databases)
    .innerJoin(schema.databaseHosts, eq(schema.databaseHosts.id, schema.databases.hostId))
    .where(eq(schema.databases.serverId, serverId));
  const failed: string[] = [];
  for (const r of rows) {
    try {
      await dropDatabase(r.h, r.d.name, r.d.username);
    } catch (e) {
      console.error(`[databases] ${r.d.name} not deleted:`, e);
      failed.push(r.d.name);
    }
  }
  return failed;
}
