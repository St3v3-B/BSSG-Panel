/**
 * API-sleutels als login: `Authorization: Bearer <key>`. Geeft een sessie van die gebruiker
 * zonder admin-schap; rechten per server = doorsnede van sleutel en gebruiker (zie accessFor).
 */
import type { Ctx, Permission, SessionCtx } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { safeEqual, sha256 } from "./lib/crypto";

export const NO_SESSION_ID = "00000000-0000-0000-0000-000000000000";

export interface ApiKeyInfo {
  id: number;
  permissions: Permission[];
}

const byHeaders = new WeakMap<Headers, ApiKeyInfo>();

export const apiKeyOf = (ctx: Ctx | undefined | null): ApiKeyInfo | null => (ctx ? (byHeaders.get(ctx.resHeaders) ?? null) : null);

export function bearerFrom(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
  return m?.[1] ?? null;
}

export async function loadApiKeySession(key: string, resHeaders: Headers): Promise<SessionCtx | null> {
  if (key.length < 16) return null;
  const db = getDb();
  const [row] = await db
    .select({ k: schema.apiKeys, u: schema.users })
    .from(schema.apiKeys)
    .innerJoin(schema.users, eq(schema.users.id, schema.apiKeys.userId))
    .where(eq(schema.apiKeys.prefix, key.slice(0, 8)));
  if (!row || !safeEqual(row.k.hash, sha256(key))) return null;
  if (row.k.expiresAt && row.k.expiresAt.getTime() <= Date.now()) return null;
  // lastUsedAt hooguit eens per minuut bijwerken.
  const now = new Date();
  await db
    .update(schema.apiKeys)
    .set({ lastUsedAt: now })
    .where(and(eq(schema.apiKeys.id, row.k.id), or(isNull(schema.apiKeys.lastUsedAt), lt(schema.apiKeys.lastUsedAt, new Date(now.getTime() - 60_000)))));
  byHeaders.set(resHeaders, { id: row.k.id, permissions: row.k.permissions as Permission[] });
  return {
    sessionId: NO_SESSION_ID,
    userId: row.u.id,
    discordId: row.u.discordId ?? "",
    isAdmin: false, // nooit admin-toegang via een sleutel
    isOwner: row.u.discordId === getEnv().OWNER_DISCORD_ID,
    isEmergency: row.u.isEmergency,
    blocked: row.u.blocked,
    totpEnabled: row.u.totpEnabled,
    totpVerified: true, // de sleutel is de login; admin blijft sessie + TOTP
  };
}

/** Voor acties die met een sleutel niet mogen (sleutels/TOTP beheren). */
export function forbidApiKey(ctx: Ctx): void {
  if (apiKeyOf(ctx)) throw new TRPCError({ code: "FORBIDDEN", message: "NOT_WITH_API_KEY" });
}
