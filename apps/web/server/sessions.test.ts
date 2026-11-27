import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { parseEnv } from "./env";
import { createSession, loadSession, SESSION_COOKIE } from "./session";
import { totpNow } from "./lib/totp";
import { baseEnv, OWNER, useHarness } from "./test/harness";

const h = useHarness();
const DAY = 86400_000;

const tokenOf = (cookie: string) => decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!);
async function extra(userId: number, verified = true) {
  const { token, sessionId } = await createSession(userId, { ip: "198.51.100.9", userAgent: "Extra Browser/1.0", totpVerified: verified });
  return { token, sessionId, cookie: `${SESSION_COOKIE}=${token}` };
}

describe("sessie-levensduur", () => {
  it("verloopt na inactiviteit en na de absolute levensduur", async () => {
    const u = await h.user({ discordId: "620000000000000001" });
    const s = await extra(u.id);
    expect(await loadSession(s.token)).not.toBeNull();
    await getDb().update(schema.sessions).set({ lastSeenAt: new Date(Date.now() - 31 * DAY) }).where(eq(schema.sessions.id, s.sessionId));
    expect(await loadSession(s.token)).toBeNull();
    const s2 = await extra(u.id);
    await getDb().update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.sessions.id, s2.sessionId));
    expect(await loadSession(s2.token)).toBeNull();
    // Een nieuwe login ruimt verlopen sessies op
    await extra(u.id);
    expect(await getDb().select().from(schema.sessions).where(eq(schema.sessions.id, s.sessionId))).toHaveLength(0);
  });

  it("last_seen_at wordt bijgewerkt (hooguit eens per minuut) en houdt de sessie levend", async () => {
    const u = await h.user({ discordId: "620000000000000002" });
    const s = await extra(u.id);
    const old = new Date(Date.now() - 20 * DAY);
    await getDb().update(schema.sessions).set({ lastSeenAt: old }).where(eq(schema.sessions.id, s.sessionId));
    expect(await loadSession(s.token)).not.toBeNull();
    const [row] = await getDb().select().from(schema.sessions).where(eq(schema.sessions.id, s.sessionId));
    expect(row!.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  it("instelbaar via SESSION_IDLE_DAYS / SESSION_MAX_DAYS", () => {
    expect(parseEnv(baseEnv())).toMatchObject({ SESSION_IDLE_DAYS: 30, SESSION_MAX_DAYS: 90 });
    expect(parseEnv(baseEnv({ SESSION_IDLE_DAYS: "7", SESSION_MAX_DAYS: "14" }))).toMatchObject({ SESSION_IDLE_DAYS: 7, SESSION_MAX_DAYS: 14 });
    expect(() => parseEnv(baseEnv({ SESSION_IDLE_DAYS: "0" }))).toThrow(/days/);
  });
});

describe("token-rotatie", () => {
  it("verifyTotp geeft een nieuw token; het oude werkt niet meer", async () => {
    const u = await h.user({ discordId: "620000000000000003", totp: true, verified: false });
    const ctx = await h.ctxFor(u.cookie);
    const { buildRouter, createCallerFactory } = await import("@panel/api");
    const { implementation } = await import("./index");
    await createCallerFactory(buildRouter(implementation))(ctx).auth.verifyTotp({ code: totpNow(u.totpSecret!) });
    const set = ctx.resHeaders.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(set).toMatch(/HttpOnly/);
    const fresh = tokenOf(set);
    expect(fresh).not.toBe(tokenOf(u.cookie));
    expect(await loadSession(tokenOf(u.cookie))).toBeNull();
    expect(await loadSession(fresh)).toMatchObject({ userId: u.id, totpVerified: true });
  });

  it("totpEnable roteert ook", async () => {
    const u = await h.user({ discordId: "620000000000000004" });
    const ctx = await h.ctxFor(u.cookie);
    const { buildRouter, createCallerFactory } = await import("@panel/api");
    const { implementation } = await import("./index");
    const api = createCallerFactory(buildRouter(implementation))(ctx);
    const { secret } = await api.account.totpSetup();
    await api.account.totpEnable({ code: totpNow(secret) });
    expect(ctx.resHeaders.getSetCookie().some((c) => c.startsWith(`${SESSION_COOKIE}=`))).toBe(true);
    expect(await loadSession(tokenOf(u.cookie))).toBeNull();
  });
});

describe("sessiebeheer", () => {
  it("lijst met huidige sessie, andere uitloggen, ingetrokken sessie wordt geweigerd", async () => {
    const u = await h.user({ discordId: "620000000000000005" });
    const other = await extra(u.id);
    const list = await u.api.account.sessions();
    expect(list).toHaveLength(2);
    expect(list.filter((x) => x.current)).toHaveLength(1);
    const o = list.find((x) => !x.current)!;
    expect(o).toMatchObject({ userAgent: "Extra Browser/1.0", ip: "198.51.100.9", id: other.sessionId });
    expect((await h.ctxFor(other.cookie)).session).not.toBeNull();
    await u.api.account.revokeSession({ id: o.id });
    expect((await h.ctxFor(other.cookie)).session).toBeNull();
    await expect(u.api.account.revokeSession({ id: o.id })).rejects.toThrow(/SESSION_NOT_FOUND/);
  });

  it("kan geen sessie van een ander intrekken", async () => {
    const a = await h.user({ discordId: "620000000000000006" });
    const b = await h.user({ discordId: "620000000000000007" });
    const [bs] = await b.api.account.sessions();
    await expect(a.api.account.revokeSession({ id: bs!.id })).rejects.toThrow(/SESSION_NOT_FOUND/);
    expect((await h.ctxFor(b.cookie)).session).not.toBeNull();
  });

  it("'overal elders uitloggen' laat alleen de huidige over", async () => {
    const u = await h.user({ discordId: "620000000000000008" });
    const x = await extra(u.id);
    const y = await extra(u.id);
    expect(await u.api.account.revokeOtherSessions()).toEqual({ revoked: 2 });
    expect((await h.ctxFor(x.cookie)).session).toBeNull();
    expect((await h.ctxFor(y.cookie)).session).toBeNull();
    expect((await h.ctxFor(u.cookie)).session).not.toBeNull();
    const log = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.userId, u.id));
    expect(log.map((l) => l.action)).toContain("account.session.revoke_others");
  });

  it("de huidige sessie intrekken wist het cookie", async () => {
    const u = await h.user({ discordId: "620000000000000009" });
    const cur = (await u.api.account.sessions())[0]!;
    await u.api.account.revokeSession({ id: cur.id });
    expect(u.ctx.resHeaders.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))).toMatch(/Max-Age=0/);
  });

  it("admin trekt alle sessies van een gebruiker in; gewone gebruiker mag dat niet", async () => {
    const owner = await h.user({ discordId: OWNER, admin: true, totp: true });
    const u = await h.user({ discordId: "620000000000000010" });
    const x = await extra(u.id);
    await expect(u.api.admin.users.revokeSessions({ id: u.id })).rejects.toThrow(/NOT_ADMIN/);
    expect(await owner.api.admin.users.revokeSessions({ id: u.id })).toEqual({ revoked: 2 });
    expect((await h.ctxFor(x.cookie)).session).toBeNull();
    expect((await h.ctxFor(u.cookie)).session).toBeNull();
    const log = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "admin.user.revoke_sessions"));
    expect(log[0]!.metadata).toMatchObject({ targetUserId: u.id, revoked: 2 });
  });
});
