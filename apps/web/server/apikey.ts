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
import { getLimiter } from "./lib/ratelimit";

export const NO_SESSION_ID = "00000000-0000-0000-0000-000000000000";

export interface ApiKeyInfo {
  id: number;
  name: string;
  permissions: Permission[];
  /** servers.id waartoe de sleutel beperkt is; leeg = alle servers van de gebruiker. */
  serverIds: number[];
}

/** Verzoeken per minuut per sleutel (alle methoden, tRPC en REST samen). */
export const API_KEY_REQUESTS_PER_MINUTE = 120;

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
  byHeaders.set(resHeaders, { id: row.k.id, name: row.k.name, permissions: row.k.permissions as Permission[], serverIds: row.k.serverIds ?? [] });
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

/** Mag deze context (sessie of sleutel) bij de server? Een sleutel met serverlijst alleen bij die servers. */
export function keyAllowsServer(ctx: Ctx | null | undefined, serverId: number): boolean {
  const key = apiKeyOf(ctx);
  return !key || !key.serverIds.length || key.serverIds.includes(serverId);
}

/** Rate limit per sleutel; gooit TOO_MANY_REQUESTS `RATE_LIMITED` (REST: 429 met Retry-After). */
export async function limitApiKey(key: ApiKeyInfo): Promise<void> {
  if ((await getLimiter().hit(`apikey:${key.id}`, 60)) > API_KEY_REQUESTS_PER_MINUTE) {
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "RATE_LIMITED" });
  }
}

/** Voor acties die met een sleutel niet mogen (sleutels/TOTP beheren). */
export function forbidApiKey(ctx: Ctx): void {
  if (apiKeyOf(ctx)) throw new TRPCError({ code: "FORBIDDEN", message: "NOT_WITH_API_KEY" });
}
