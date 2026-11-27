/** Gemeenschappelijk voor Discord-login en test-login: account aanmaken/bijwerken + sessie. */
import { and, eq, sql } from "drizzle-orm";
import { logActivity } from "./activity";
import { getDb, schema } from "./db";
import { notify } from "./notify";
import { createSession, sessionCookie, cookieSecure } from "./session";

export interface DiscordProfile {
  discordId: string;
  name: string;
  avatarUrl: string | null;
}

export type LoginResult = { ok: true; userId: number; setCookie: string; totpPending: boolean } | { ok: false; reason: "blocked" };

export function clientIp(req: Request): string | null {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || null;
}

export async function loginWithProfile(p: DiscordProfile, req: Request, via: "discord" | "test"): Promise<LoginResult> {
  const db = getDb();
  const ip = clientIp(req);
  const [user] = await db
    .insert(schema.users)
    .values({ discordId: p.discordId, name: p.name, avatarUrl: p.avatarUrl })
    .onConflictDoUpdate({
      target: schema.users.discordId,
      set: { name: p.name, avatarUrl: p.avatarUrl ?? sql`${schema.users.avatarUrl}` },
    })
    .returning();
  if (!user) throw new Error("user not created");
  if (user.blocked) {
    await logActivity({ action: "auth.login.blocked", userId: user.id, metadata: { via }, ip });
    return { ok: false, reason: "blocked" };
  }
  const newIp = await isNewLoginIp(user.id, ip);
  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));
  const { token } = await createSession(user.id, { ip, userAgent: req.headers.get("user-agent"), totpVerified: false });
  await logActivity({ action: "auth.login", userId: user.id, metadata: { via }, ip });
  if (newIp && ip) await notify({ kind: "login_new_ip", ip, userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null }, { server: null, hooks: [], admin: false, users: [user.id] });
  return { ok: true, userId: user.id, setCookie: sessionCookie(token, cookieSecure(req)), totpPending: user.totpEnabled };
}

/**
 * Een login vanaf een IP dat deze gebruiker nog nooit gebruikte (bij een eerdere login of sessie).
 * De allereerste login telt niet: dan is elk IP nieuw.
 */
export async function isNewLoginIp(userId: number, ip: string | null): Promise<boolean> {
  if (!ip) return false;
  const db = getDb();
  const [prev] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.activityLog).where(and(eq(schema.activityLog.userId, userId), eq(schema.activityLog.action, "auth.login")));
  if (!prev?.n) return false;
  const [seen] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.userId, userId), eq(schema.activityLog.action, "auth.login"), eq(schema.activityLog.ip, ip)));
  if (seen?.n) return false;
  const [sess] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.sessions).where(and(eq(schema.sessions.userId, userId), eq(schema.sessions.ip, ip)));
  return !sess?.n;
}
