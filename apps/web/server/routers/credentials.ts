/** account.setSftpPassword en API-sleutels. */
import { hash } from "@node-rs/argon2";
import type { Implementation, Permission } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { logActivity } from "../activity";
import { forbidApiKey } from "../apikey";
import { getDb, schema } from "../db";
import { randomToken, sha256 } from "../lib/crypto";
import { requireServer } from "../servers-data";

/** Argon2id met de standaardparameters van @node-rs/argon2 (m=19 MiB, t=2, p=1). */
export const hashPassword = (pw: string) => hash(pw, { algorithm: 2 });

type KeyRow = typeof schema.apiKeys.$inferSelect;
const toApiKey = (k: KeyRow, uuids: Map<number, string>) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  permissions: k.permissions as Permission[],
  // Verwijderde servers vallen weg; de sleutel blijft dan tot de overige beperkt.
  serverUuids: (k.serverIds ?? []).flatMap((id) => (uuids.has(id) ? [uuids.get(id)!] : [])),
  lastUsedAt: k.lastUsedAt,
  expiresAt: k.expiresAt,
  createdAt: k.createdAt,
});

async function uuidsOf(ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const rows = await getDb().select({ id: schema.servers.id, uuid: schema.servers.uuid }).from(schema.servers).where(inArray(schema.servers.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.uuid]));
}

export const credentials: Pick<Implementation["account"], "setSftpPassword" | "apiKeys" | "createApiKey" | "revokeApiKey"> = {
  setSftpPassword: async ({ input, ctx }) => {
    // Een (beperkte) API-sleutel mag het SFTP-wachtwoord niet zetten: SFTP geeft de volledige rechten van de gebruiker.
    forbidApiKey(ctx);
    const a = await requireServer(ctx, input.uuid, "files.read", { mutates: true });
    const uid = ctx.session!.userId;
    const passwordHash = await hashPassword(input.password);
    await getDb()
      .insert(schema.sftpCredentials)
      .values({ userId: uid, serverId: a.bundle.server.id, passwordHash })
      .onConflictDoUpdate({ target: [schema.sftpCredentials.userId, schema.sftpCredentials.serverId], set: { passwordHash, createdAt: sql`now()` } });
    await logActivity({ action: "server.sftp.password", userId: uid, serverId: a.bundle.server.id, ip: ctx.ip, ctx });
    return { ok: true as const };
  },

  apiKeys: async ({ ctx }) => {
    const rows = await getDb().select().from(schema.apiKeys).where(eq(schema.apiKeys.userId, ctx.session!.userId)).orderBy(desc(schema.apiKeys.id));
    const uuids = await uuidsOf(rows.flatMap((r) => r.serverIds ?? []));
    return rows.map((r) => toApiKey(r, uuids));
  },

  createApiKey: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new TRPCError({ code: "BAD_REQUEST", message: "EXPIRES_IN_PAST" });
    const uid = ctx.session!.userId;
    // Beperking per server: alleen servers waar de gebruiker zelf bij kan.
    const serverIds: number[] = [];
    const uuids = new Map<number, string>();
    for (const u of [...new Set(input.serverUuids.map((x) => x.toLowerCase()))]) {
      const a = await requireServer(ctx, u, "any");
      serverIds.push(a.bundle.server.id);
      uuids.set(a.bundle.server.id, a.bundle.server.uuid);
    }
    for (let i = 0; i < 5; i++) {
      const key = randomToken(32); // 43 tekens base64url; de eerste 8 zijn het prefix
      const rows = await getDb()
        .insert(schema.apiKeys)
        .values({ userId: uid, name: input.name, prefix: key.slice(0, 8), hash: sha256(key), permissions: [...new Set(input.permissions)], serverIds, expiresAt: input.expiresAt })
        .onConflictDoNothing()
        .returning();
      if (rows[0]) {
        await logActivity({ action: "account.api_key.create", userId: uid, metadata: { id: rows[0].id, name: input.name, permissions: rows[0].permissions, servers: [...uuids.values()] }, ip: ctx.ip, ctx });
        return { key, apiKey: toApiKey(rows[0], uuids) };
      }
    }
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "KEY_GENERATION_FAILED" });
  },

  revokeApiKey: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const uid = ctx.session!.userId;
    const r = await getDb().delete(schema.apiKeys).where(and(eq(schema.apiKeys.id, input.id), eq(schema.apiKeys.userId, uid))).returning();
    if (!r.length) throw new TRPCError({ code: "NOT_FOUND", message: "API_KEY_NOT_FOUND" });
    await logActivity({ action: "account.api_key.revoke", userId: uid, metadata: { id: input.id }, ip: ctx.ip, ctx });
    return { ok: true as const };
  },
};
