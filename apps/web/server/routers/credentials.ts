/** account.setSftpPassword en API-sleutels. */
import { hash } from "@node-rs/argon2";
import type { Implementation, Permission } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { logActivity } from "../activity";
import { getDb, schema } from "../db";
import { randomToken, sha256 } from "../lib/crypto";
import { requireServer } from "../servers-data";

/** Argon2id met de standaardparameters van @node-rs/argon2 (m=19 MiB, t=2, p=1). */
export const hashPassword = (pw: string) => hash(pw, { algorithm: 2 });

type KeyRow = typeof schema.apiKeys.$inferSelect;
const toApiKey = (k: KeyRow) => ({
  id: k.id,
  name: k.name,
  prefix: k.prefix,
  permissions: k.permissions as Permission[],
  lastUsedAt: k.lastUsedAt,
  expiresAt: k.expiresAt,
  createdAt: k.createdAt,
});

export const credentials: Pick<Implementation["account"], "setSftpPassword" | "apiKeys" | "createApiKey" | "revokeApiKey"> = {
  setSftpPassword: async ({ input, ctx }) => {
    const a = await requireServer(ctx, input.uuid, "files.read");
    const uid = ctx.session!.userId;
    const passwordHash = await hashPassword(input.password);
    await getDb()
      .insert(schema.sftpCredentials)
      .values({ userId: uid, serverId: a.bundle.server.id, passwordHash })
      .onConflictDoUpdate({ target: [schema.sftpCredentials.userId, schema.sftpCredentials.serverId], set: { passwordHash, createdAt: sql`now()` } });
    await logActivity({ action: "server.sftp.password", userId: uid, serverId: a.bundle.server.id, ip: ctx.ip });
    return { ok: true as const };
  },

  apiKeys: async ({ ctx }) => {
    const rows = await getDb().select().from(schema.apiKeys).where(eq(schema.apiKeys.userId, ctx.session!.userId)).orderBy(desc(schema.apiKeys.id));
    return rows.map(toApiKey);
  },

  createApiKey: async ({ input, ctx }) => {
    if (input.expiresAt && input.expiresAt.getTime() <= Date.now()) throw new TRPCError({ code: "BAD_REQUEST", message: "EXPIRES_IN_PAST" });
    const uid = ctx.session!.userId;
    for (let i = 0; i < 5; i++) {
      const key = randomToken(32); // 43 tekens base64url; de eerste 8 zijn het prefix
      const rows = await getDb()
        .insert(schema.apiKeys)
        .values({ userId: uid, name: input.name, prefix: key.slice(0, 8), hash: sha256(key), permissions: [...new Set(input.permissions)], expiresAt: input.expiresAt })
        .onConflictDoNothing()
        .returning();
      if (rows[0]) {
        await logActivity({ action: "account.api_key.create", userId: uid, metadata: { id: rows[0].id, name: input.name }, ip: ctx.ip });
        return { key, apiKey: toApiKey(rows[0]) };
      }
    }
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "KEY_GENERATION_FAILED" });
  },

  revokeApiKey: async ({ input, ctx }) => {
    const uid = ctx.session!.userId;
    const r = await getDb().delete(schema.apiKeys).where(and(eq(schema.apiKeys.id, input.id), eq(schema.apiKeys.userId, uid))).returning();
    if (!r.length) throw new TRPCError({ code: "NOT_FOUND", message: "API_KEY_NOT_FOUND" });
    await logActivity({ action: "account.api_key.revoke", userId: uid, metadata: { id: input.id }, ip: ctx.ip });
    return { ok: true as const };
  },
};
