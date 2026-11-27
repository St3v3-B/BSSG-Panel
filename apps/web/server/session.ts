/**
 * Sessies (tabel `sessions`, alleen SHA-256 van het token) en het cookie `panel_session`.
 */
import type { SessionCtx } from "@panel/api";
import { and, eq, gt, lt, ne } from "drizzle-orm";
import { getDb, schema } from "./db";
import { getEnv } from "./env";
import { randomToken, sha256 } from "./lib/crypto";

export const SESSION_COOKIE = "panel_session";
const DAY_MS = 24 * 3600_000;
/** Absolute levensduur van een sessie (SESSION_MAX_DAYS). */
export const sessionMaxMs = () => getEnv().SESSION_MAX_DAYS * DAY_MS;
/** Zonder gebruik verloopt een sessie na zoveel tijd (SESSION_IDLE_DAYS). */
export const sessionIdleMs = () => getEnv().SESSION_IDLE_DAYS * DAY_MS;
/** last_seen_at wordt hooguit zo vaak bijgewerkt. */
const TOUCH_INTERVAL_MS = 60_000;

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

export const sessionCookie = (token: string, secure: boolean) => cookie(SESSION_COOKIE, token, { secure, maxAgeSeconds: sessionMaxMs() / 1000 });
export const clearSessionCookie = (secure: boolean) => cookie(SESSION_COOKIE, "", { secure, maxAgeSeconds: 0 });

export async function createSession(userId: number, opts: { ip: string | null; userAgent: string | null; totpVerified: boolean }): Promise<{ token: string; sessionId: string }> {
  const token = randomToken(32);
  await purgeExpiredSessions().catch(() => {});
  const [row] = await getDb()
    .insert(schema.sessions)
    .values({
      userId,
      tokenHash: sha256(token),
      totpVerified: opts.totpVerified,
      ip: opts.ip,
      userAgent: opts.userAgent?.slice(0, 500) ?? null,
      expiresAt: new Date(Date.now() + sessionMaxMs()),
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
      lastSeenAt: schema.sessions.lastSeenAt,
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
    .where(
      and(
        eq(schema.sessions.tokenHash, sha256(token)),
        gt(schema.sessions.expiresAt, new Date()),
        gt(schema.sessions.lastSeenAt, new Date(Date.now() - sessionIdleMs())),
      ),
    );
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .update(schema.sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.sessions.id, row.sessionId));
  }
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

/**
 * Geeft de sessie een nieuw token (bij een rechtenwijziging, zoals na TOTP-verificatie) zodat een
 * eerder gelekt of vastgezet token niets meer waard is. Geeft de Set-Cookie-waarde terug.
 */
export async function rotateSession(sessionId: string, secure: boolean): Promise<string> {
  const token = randomToken(32);
  await getDb().update(schema.sessions).set({ tokenHash: sha256(token), lastSeenAt: new Date() }).where(eq(schema.sessions.id, sessionId));
  return sessionCookie(token, secure);
}

/** Beëindigt alle sessies van een gebruiker (optioneel behalve één); geeft het aantal. */
export async function deleteUserSessions(userId: number, exceptSessionId?: string): Promise<number> {
  const rows = await getDb()
    .delete(schema.sessions)
    .where(and(eq(schema.sessions.userId, userId), exceptSessionId ? ne(schema.sessions.id, exceptSessionId) : undefined))
    .returning({ id: schema.sessions.id });
  return rows.length;
}

/** Ruimt verlopen en inactieve sessies op. */
export async function purgeExpiredSessions(): Promise<void> {
  await getDb()
    .delete(schema.sessions)
    .where(lt(schema.sessions.expiresAt, new Date()));
  await getDb()
    .delete(schema.sessions)
    .where(lt(schema.sessions.lastSeenAt, new Date(Date.now() - sessionIdleMs())));
}
