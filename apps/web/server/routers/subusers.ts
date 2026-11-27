/** subusers.*: alleen de eigenaar (of een volledige admin) beheert subusers. */
import { DiscordId, type Implementation, type Permission } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { logActivity } from "../activity";
import { getDb, schema } from "../db";
import { requireServer, userPublic } from "../servers-data";

const uniq = (p: Permission[]) => [...new Set(p)];

/** Discord-ID (onbekend → leeg account) of de naam van een bestaande gebruiker. */
async function resolveUser(who: string) {
  const db = getDb();
  const w = who.trim();
  if (DiscordId.safeParse(w).success) {
    await db.insert(schema.users).values({ discordId: w }).onConflictDoNothing();
    const [u] = await db.select().from(schema.users).where(eq(schema.users.discordId, w));
    return u!;
  }
  const found = await db.select().from(schema.users).where(sql`lower(${schema.users.name}) = lower(${w})`).limit(2);
  if (found.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "USER_NOT_FOUND" });
  if (found.length > 1) throw new TRPCError({ code: "CONFLICT", message: "USER_AMBIGUOUS: use the Discord ID" });
  return found[0]!;
}

async function subuserRow(serverId: number, userId: number) {
  const [r] = await getDb()
    .select({ sub: schema.subusers, user: schema.users })
    .from(schema.subusers)
    .innerJoin(schema.users, eq(schema.users.id, schema.subusers.userId))
    .where(and(eq(schema.subusers.serverId, serverId), eq(schema.subusers.userId, userId)));
  return r ?? null;
}

const toSubuser = (r: NonNullable<Awaited<ReturnType<typeof subuserRow>>>) => ({
  user: userPublic(r.user),
  permissions: r.sub.permissions as Permission[],
  createdAt: r.sub.createdAt,
});

export const subusers: Implementation["subusers"] = {
  list: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner");
    const rows = await getDb()
      .select({ sub: schema.subusers, user: schema.users })
      .from(schema.subusers)
      .innerJoin(schema.users, eq(schema.users.id, schema.subusers.userId))
      .where(eq(schema.subusers.serverId, a.bundle.server.id))
      .orderBy(asc(schema.subusers.createdAt), asc(schema.users.id));
    return rows.map(toSubuser);
  },

  invite: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner");
    const u = await resolveUser(input.who);
    if (u.id === a.bundle.server.ownerId) throw new TRPCError({ code: "BAD_REQUEST", message: "IS_OWNER" });
    const inserted = await getDb()
      .insert(schema.subusers)
      .values({ serverId: a.bundle.server.id, userId: u.id, permissions: uniq(input.permissions) })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) throw new TRPCError({ code: "CONFLICT", message: "ALREADY_SUBUSER" });
    await logActivity({ action: "server.subuser.invite", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { subuserId: u.id, permissions: input.permissions }, ip: ctx.ip, ctx });
    return toSubuser((await subuserRow(a.bundle.server.id, u.id))!);
  },

  update: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner");
    const r = await getDb()
      .update(schema.subusers)
      .set({ permissions: uniq(input.permissions) })
      .where(and(eq(schema.subusers.serverId, a.bundle.server.id), eq(schema.subusers.userId, input.userId)))
      .returning();
    if (!r.length) throw new TRPCError({ code: "NOT_FOUND", message: "SUBUSER_NOT_FOUND" });
    await logActivity({ action: "server.subuser.update", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { subuserId: input.userId, permissions: input.permissions }, ip: ctx.ip, ctx });
    return toSubuser((await subuserRow(a.bundle.server.id, input.userId))!);
  },

  remove: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "owner");
    const db = getDb();
    const r = await db.delete(schema.subusers).where(and(eq(schema.subusers.serverId, a.bundle.server.id), eq(schema.subusers.userId, input.userId))).returning();
    if (!r.length) throw new TRPCError({ code: "NOT_FOUND", message: "SUBUSER_NOT_FOUND" });
    // SFTP-wachtwoord voor deze server vervalt mee.
    await db.delete(schema.sftpCredentials).where(and(eq(schema.sftpCredentials.serverId, a.bundle.server.id), eq(schema.sftpCredentials.userId, input.userId)));
    await logActivity({ action: "server.subuser.remove", userId: ctx.session!.userId, serverId: a.bundle.server.id, metadata: { subuserId: input.userId }, ip: ctx.ip, ctx });
    return { ok: true as const };
  },
};
