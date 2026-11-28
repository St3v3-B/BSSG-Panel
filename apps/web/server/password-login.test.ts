import { buildRouter, createCallerFactory } from "@panel/api";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { setEmergencyCredentials } from "./emergency";
import { implementation } from "./index";
import { PASSWORD_LOGIN_IP_MAX, PASSWORD_LOGIN_USER_MAX } from "./password-login";
import { OWNER, useHarness } from "./test/harness";

const h = useHarness();
const caller = createCallerFactory(buildRouter(implementation));
const PW = "een lang backup wachtwoord";

let ipSeq = 10;
const freshIp = () => `198.51.100.${ipSeq++}`;

/** Inloggen als anoniem; geeft de context van de nieuwe sessie terug. */
async function login(username: string, password: string, ip = freshIp()) {
  const ctx = { ...(await h.ctxFor(null)), ip };
  await caller(ctx).auth.passwordLogin({ username, password });
  const cookie = ctx.resHeaders.getSetCookie().find((c) => c.startsWith("panel_session="))!.split(";")[0]!;
  const sctx = await h.ctxFor(cookie);
  return { ctx: sctx, api: caller(sctx) };
}

describe("backup-login (gebruikersnaam + wachtwoord)", () => {
  it("staat standaard uit; AdminUser.passwordLogin is false", async () => {
    const owner = await h.user({ discordId: OWNER, admin: true, totp: true });
    const u = await h.user({ discordId: "300000000000000001" });
    expect(await u.api.account.passwordLogin()).toEqual({ enabled: false, username: null, updatedAt: null, setByAdmin: false });
    expect((await owner.api.admin.users.get({ id: u.id })).passwordLogin).toBe(false);
    const [row] = await getDb().select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(row!.loginUsername).toBeNull();
    expect(row!.passwordHash).toBeNull();
  });

  it("aanzetten + inloggen geeft een gewone sessie; login gelogd met via=password; hash is Argon2id", async () => {
    const owner = await h.user({ discordId: OWNER, admin: true, totp: true });
    const u = await h.user({ discordId: "300000000000000002" });
    const st = await u.api.account.setPasswordLogin({ username: "Alice.Backup", password: PW });
    expect(st).toMatchObject({ enabled: true, username: "alice.backup", setByAdmin: false });
    expect(st.updatedAt).toBeInstanceOf(Date);
    expect(await u.api.account.passwordLogin()).toMatchObject({ enabled: true, username: "alice.backup" });
    expect((await owner.api.admin.users.get({ id: u.id })).passwordLogin).toBe(true);
    const [row] = await getDb().select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(row!.passwordHash).toMatch(/^\$argon2id\$/);

    const s = await login("ALICE.backup", PW, "198.51.100.200");
    // Zonder TOTP telt de sessie als geverifieerd (session.ts), net als na een Discord-login.
    expect(s.ctx.session).toMatchObject({ userId: u.id, totpVerified: true });
    expect((await s.api.account.get()).user.id).toBe(u.id);
    const [after] = await getDb().select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(after!.lastLoginAt).toBeInstanceOf(Date);

    const log = await getDb().select().from(schema.activityLog).where(and(eq(schema.activityLog.userId, u.id), eq(schema.activityLog.action, "auth.login")));
    expect(log.some((l) => (l.metadata as { via?: string }).via === "password" && l.ip === "198.51.100.200")).toBe(true);
    const set = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "account.password_login.set"));
    expect(set.length).toBeGreaterThan(0);
    // Het wachtwoord staat nergens in het log.
    const all = await getDb().select().from(schema.activityLog);
    expect(JSON.stringify(all)).not.toContain(PW);
  });

  it("verkeerd wachtwoord en onbekende naam geven dezelfde fout en worden gelogd", async () => {
    const u = await h.user({ discordId: "300000000000000003" });
    await u.api.account.setPasswordLogin({ username: "bob", password: PW });
    await expect(login("bob", "fout wachtwoord!!", freshIp())).rejects.toThrow(/INVALID_CREDENTIALS/);
    await expect(login("bestaat-niet", PW, freshIp())).rejects.toThrow(/INVALID_CREDENTIALS/);
    const failed = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "auth.password_login.failed"));
    expect(failed.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(failed)).not.toContain("fout wachtwoord");
  });

  it("rate limit per gebruikersnaam en per IP", async () => {
    const u = await h.user({ discordId: "300000000000000004" });
    await u.api.account.setPasswordLogin({ username: "carol", password: PW });
    // Per naam: steeds een ander IP.
    for (let i = 0; i < PASSWORD_LOGIN_USER_MAX; i++) await expect(login("carol", "verkeerd-wachtwoord", freshIp())).rejects.toThrow(/INVALID_CREDENTIALS/);
    await expect(login("carol", PW, freshIp())).rejects.toThrow(/TOO_MANY_ATTEMPTS/);
    // Per IP: steeds een andere (onbekende) naam.
    const ip = freshIp();
    for (let i = 0; i < PASSWORD_LOGIN_IP_MAX; i++) await expect(login(`onbekend${i}`, "verkeerd-wachtwoord", ip)).rejects.toThrow(/INVALID_CREDENTIALS/);
    const v = await h.user({ discordId: "300000000000000005" });
    await v.api.account.setPasswordLogin({ username: "dave", password: PW });
    await expect(login("dave", PW, ip)).rejects.toThrow(/TOO_MANY_ATTEMPTS/);
    await expect(login("dave", PW, freshIp())).resolves.toBeTruthy();
  });

  it("geblokkeerd: BLOCKED alleen met het juiste wachtwoord", async () => {
    const u = await h.user({ discordId: "300000000000000006" });
    await u.api.account.setPasswordLogin({ username: "erin", password: PW });
    await getDb().update(schema.users).set({ blocked: true }).where(eq(schema.users.id, u.id));
    await expect(login("erin", "verkeerd-wachtwoord", freshIp())).rejects.toThrow(/INVALID_CREDENTIALS/);
    await expect(login("erin", PW, freshIp())).rejects.toThrow(/BLOCKED/);
  });

  it("met TOTP aan: code verplicht bij instellen, sessie na login is pending", async () => {
    const u = await h.user({ discordId: "300000000000000007", totp: true });
    await expect(u.api.account.setPasswordLogin({ username: "frank", password: PW })).rejects.toThrow(/INVALID_CODE/);
    await expect(u.api.account.setPasswordLogin({ username: "frank", password: PW, code: "000000" === h.totp(u) ? "111111" : "000000" })).rejects.toThrow(/INVALID_CODE/);
    await expect(u.api.account.passwordLogin()).resolves.toMatchObject({ enabled: false });
    await u.api.account.setPasswordLogin({ username: "frank", password: PW, code: h.totp(u) });
    const s = await login("frank", PW, freshIp());
    expect(s.ctx.session).toMatchObject({ userId: u.id, totpEnabled: true, totpVerified: false });
    await expect(s.api.account.get()).rejects.toThrow(/TOTP_PENDING/);
    expect(await s.api.auth.me()).toMatchObject({ totpEnabled: true, totpVerified: false });
  });

  it("naam al in gebruik → USERNAME_TAKEN; eigen naam opnieuw zetten mag", async () => {
    const a = await h.user({ discordId: "300000000000000008" });
    const b = await h.user({ discordId: "300000000000000009" });
    await a.api.account.setPasswordLogin({ username: "gina", password: PW });
    await expect(b.api.account.setPasswordLogin({ username: "GINA", password: PW })).rejects.toThrow(/USERNAME_TAKEN/);
    await expect(a.api.account.setPasswordLogin({ username: "gina", password: `${PW}2` })).resolves.toMatchObject({ username: "gina" });
    const owner = await h.user({ discordId: OWNER, admin: true, totp: true });
    await expect(owner.api.admin.users.setPasswordLogin({ id: b.id, username: "gina" })).rejects.toThrow(/USERNAME_TAKEN/);
  });

  it("noodaccount: instellen geweigerd, uitschakelen raakt zijn wachtwoord niet", async () => {
    await setEmergencyCredentials("correct horse battery staple");
    const [em] = await getDb().select().from(schema.users).where(eq(schema.users.isEmergency, true));
    const owner = await h.user({ discordId: OWNER, admin: true, totp: true });
    await expect(owner.api.admin.users.setPasswordLogin({ id: em!.id, username: "nood" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(owner.api.admin.users.disablePasswordLogin({ id: em!.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [after] = await getDb().select().from(schema.users).where(eq(schema.users.id, em!.id));
    expect(after!.passwordHash).toBe(em!.passwordHash);
    expect(after!.loginUsername).toBeNull();
    await expect(owner.api.admin.users.getPasswordLogin({ id: 999_999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("admin zet een wachtwoord: komt één keer terug en werkt; gebruiker overschrijft het zelf", async () => {
    const owner = await h.user({ discordId: OWNER, admin: true, totp: true });
    const u = await h.user({ discordId: "300000000000000010" });
    const r = await owner.api.admin.users.setPasswordLogin({ id: u.id, username: "henk" });
    expect(r.password.length).toBeGreaterThanOrEqual(20);
    expect(r.status).toMatchObject({ enabled: true, username: "henk", setByAdmin: true });
    expect(await owner.api.admin.users.getPasswordLogin({ id: u.id })).toMatchObject({ enabled: true, setByAdmin: true });
    expect(JSON.stringify(await owner.api.admin.users.getPasswordLogin({ id: u.id }))).not.toContain(r.password);
    const s = await login("henk", r.password, freshIp());
    expect(s.ctx.session!.userId).toBe(u.id);
    const log = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "admin.user.password_login.set"));
    expect(log.some((l) => l.userId === owner.id && (l.metadata as { targetUserId?: number }).targetUserId === u.id)).toBe(true);
    expect(JSON.stringify(log)).not.toContain(r.password);
    expect(await u.api.account.setPasswordLogin({ username: "henk", password: PW })).toMatchObject({ setByAdmin: false });
  });

  it("uitschakelen (zelf of door admin) maakt inloggen onmogelijk en wist alles", async () => {
    const owner = await h.user({ discordId: OWNER, admin: true, totp: true });
    const u = await h.user({ discordId: "300000000000000011" });
    await u.api.account.setPasswordLogin({ username: "ivo", password: PW });
    expect(await u.api.account.disablePasswordLogin()).toEqual({ enabled: false, username: null, updatedAt: null, setByAdmin: false });
    await expect(login("ivo", PW, freshIp())).rejects.toThrow(/INVALID_CREDENTIALS/);
    const [row] = await getDb().select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(row).toMatchObject({ loginUsername: null, passwordHash: null, passwordSetAt: null, passwordSetByAdmin: false });

    const r = await owner.api.admin.users.setPasswordLogin({ id: u.id, username: "ivo" });
    await expect(login("ivo", r.password, freshIp())).resolves.toBeTruthy();
    expect(await owner.api.admin.users.disablePasswordLogin({ id: u.id })).toMatchObject({ enabled: false });
    await expect(login("ivo", r.password, freshIp())).rejects.toThrow(/INVALID_CREDENTIALS/);
    expect((await owner.api.admin.users.get({ id: u.id })).passwordLogin).toBe(false);
  });

  it("niet-admin kan de admin-procedures niet aanroepen; anoniem niet de account-procedures", async () => {
    const u = await h.user({ discordId: "300000000000000012" });
    const other = await h.user({ discordId: "300000000000000013" });
    await expect(u.api.admin.users.getPasswordLogin({ id: other.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(u.api.admin.users.setPasswordLogin({ id: other.id, username: "jan" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(u.api.admin.users.disablePasswordLogin({ id: other.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const anon = await h.anon();
    await expect(anon.account.passwordLogin()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(anon.account.setPasswordLogin({ username: "jan", password: PW })).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
