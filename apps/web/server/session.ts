/**
 * Sessies (tabel `sessions`, alleen SHA-256 van het token) en het cookie `panel_session`.
 */
import type { SessionCtx } from "@panel/api";
import { and, eq, gt } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { randomToken, sha256 } from "./lib/crypto";

export const SESSION_COOKIE = "panel_session";
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export function parseCookies(header: string | null): Map<string, string> {
  const m = new Map<string, string>();
  if (!header) return m;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || m.has(k)) continue;
    try {
      m.set(k, decodeURIComponent(part.slice(i + 1).trim()));
    } catch {
      m.set(k, part.slice(i + 1).trim());
    }
  }
  return m;
}

/** Secure behalve bij een .test-domein over http. */
export function cookieSecure(req: Request): boolean {
  if (!getEnv().isTestDomain) return true;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? new URL(req.url).protocol.replace(":", "");
  return proto === "https";
}

export function cookie(name: string, value: string, opts: { secure: boolean; maxAgeSeconds: number; path?: string }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? "/"}`,
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`,
    ...(opts.maxAgeSeconds <= 0 ? ["Expires=Thu, 01 Jan 1970 00:00:00 GMT"] : []),
    ...(opts.secure ? ["Secure"] : []),
  ].join("; ");
}

export const sessionCookie = (token: string, secure: boolean) => cookie(SESSION_COOKIE, token, { secure, maxAgeSeconds: SESSION_TTL_MS / 1000 });
export const clearSessionCookie = (secure: boolean) => cookie(SESSION_COOKIE, "", { secure, maxAgeSeconds: 0 });

export async function createSession(userId: number, opts: { ip: string | null; userAgent: string | null; totpVerified: boolean }): Promise<{ token: string; sessionId: string }> {
  const token = randomToken(32);
  const [row] = await getDb()
    .insert(schema.sessions)
    .values({
      userId,
      tokenHash: sha256(token),
      totpVerified: opts.totpVerified,
      ip: opts.ip,
      userAgent: opts.userAgent?.slice(0, 500) ?? null,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
    })
    .returning({ id: schema.sessions.id });
  return { token, sessionId: row!.id };
}

export function sessionTokenFrom(req: Request): string | null {
  return parseCookies(req.headers.get("cookie")).get(SESSION_COOKIE) ?? null;
}

/** Zoekt de sessie op; admin-schap komt bij elk verzoek vers uit admin_discord_ids. */
export async function loadSession(token: string): Promise<SessionCtx | null> {
  const db = getDb();
  const [row] = await db
    .select({
      sessionId: schema.sessions.id,
      totpVerified: schema.sessions.totpVerified,
      userId: schema.users.id,
      discordId: schema.users.discordId,
      blocked: schema.users.blocked,
      isEmergency: schema.users.isEmergency,
      totpEnabled: schema.users.totpEnabled,
      adminId: schema.adminDiscordIds.discordId,
    })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
    .leftJoin(schema.adminDiscordIds, eq(schema.adminDiscordIds.discordId, schema.users.discordId))
    .where(and(eq(schema.sessions.tokenHash, sha256(token)), gt(schema.sessions.expiresAt, new Date())));
  if (!row) return null;
  const owner = getEnv().OWNER_DISCORD_ID;
  return {
    sessionId: row.sessionId,
    userId: row.userId,
    discordId: row.discordId ?? "",
    // Het noodaccount heeft geen Discord-ID; TOTP is voor hem altijd verplicht (zie emergency.ts).
    isAdmin: row.adminId !== null || row.isEmergency,
    isOwner: row.discordId === owner,
    isEmergency: row.isEmergency,
    blocked: row.blocked,
    totpEnabled: row.totpEnabled,
    totpVerified: row.totpEnabled ? row.totpVerified : true,
  };
}

export async function deleteSession(sessionId: string): Promise<void> {
  await getDb().delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
}
