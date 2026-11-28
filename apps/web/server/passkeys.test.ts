import { buildRouter, createCallerFactory, type PasskeyResponse } from "@panel/api";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { setEmergencyCredentials } from "./emergency";
import { implementation } from "./index";
import { PASSKEY_LOGIN_IP_MAX } from "./passkeys";
import { OWNER, useHarness, type TestUser } from "./test/harness";
import { SoftPasskey } from "./test/webauthn";

const h = useHarness();
const caller = createCallerFactory(buildRouter(implementation));

let ipSeq = 10;
const freshIp = () => `203.0.113.${ipSeq++}`;
const asResp = (x: unknown) => x as PasskeyResponse;
let discordSeq = 1;
const nextDiscord = () => `40000000000000${String(discordSeq++).padStart(4, "0")}`;

/** Registreert een nieuwe software-passkey voor de gebruiker. */
async function registerKey(u: TestUser, name = "Testsleutel", pk = new SoftPasskey()) {
  const opts = (await u.api.account.passkeys.registerOptions()) as { challenge: string; user: { id: string } };
  const row = await u.api.account.passkeys.register({ name, response: asResp(pk.register(opts)) });
  return { pk, row };
}

async function anon(ip = freshIp()) {
  const ctx = { ...(await h.ctxFor(null)), ip };
  return { ctx, api: caller(ctx) };
}

/** Login met passkey; geeft de context van de nieuwe sessie. */
async function passkeyLogin(pk: SoftPasskey, over: Parameters<SoftPasskey["assert"]>[1] = {}, ip = freshIp()) {
  const a = await anon(ip);
  const opts = await a.api.auth.passkeyLoginOptions();
  await a.api.auth.passkeyLogin({ response: asResp(pk.assert(opts, over)) });
  const cookie = a.ctx.resHeaders.getSetCookie().find((c) => c.startsWith("panel_session="))!.split(";")[0]!;
  const sctx = await h.ctxFor(cookie);
  return { ctx: sctx, api: caller(sctx) };
}

const actions = async (action: string, userId?: number) =>
  getDb().select().from(schema.activityLog).where(and(eq(schema.activityLog.action, action), userId !== undefined ? eq(schema.activityLog.userId, userId) : undefined));

describe("passkeys: registratie", () => {
  it("registreren, lijst, hernoemen, verwijderen (met activity log)", async () => {
    const u = await h.user({ discordId: nextDiscord() });
    const opts = (await u.api.account.passkeys.registerOptions()) as Record<string, unknown>;
    expect(opts).toMatchObject({ rp: { id: "panel.test" }, authenticatorSelection: { residentKey: "required", userVerification: "required" } });
    const pk = new SoftPasskey({ backedUp: true });
    const row = await u.api.account.passkeys.register({ name: "  Laptop  ", response: asResp(pk.register(opts as { challenge: string })) });
    expect(row).toMatchObject({ name: "Laptop", lastUsedAt: null, backedUp: true, transports: ["internal", "hybrid"] });
    expect(await u.api.account.passkeys.list()).toHaveLength(1);
    const [db] = await getDb().select().from(schema.passkeys).where(eq(schema.passkeys.id, row.id));
    expect(db).toMatchObject({ userId: u.id, credentialId: pk.id, counter: 0, deviceType: "multiDevice" });

    expect(await u.api.account.passkeys.rename({ id: row.id, name: "Werklaptop" })).toMatchObject({ name: "Werklaptop" });
    await u.api.account.passkeys.delete({ id: row.id });
    expect(await u.api.account.passkeys.list()).toHaveLength(0);
    await expect(u.api.account.passkeys.delete({ id: row.id })).rejects.toThrow(/PASSKEY_NOT_FOUND/);
    for (const a of ["account.passkey.register", "account.passkey.rename", "account.passkey.delete"]) expect(await actions(a, u.id)).toHaveLength(1);
  });

  it("vereist een volledig geverifieerde sessie (pending → TOTP_PENDING) en geen API-sleutel", async () => {
    const u = await h.user({ discordId: nextDiscord(), totp: true, verified: false });
    await expect(u.api.account.passkeys.registerOptions()).rejects.toThrow(/TOTP_PENDING/);
    await expect(u.api.account.passkeys.list()).rejects.toThrow(/TOTP_PENDING/);
    const anonApi = (await anon()).api;
    await expect(anonApi.account.passkeys.registerOptions()).rejects.toThrow(/UNAUTHORIZED/);

    const v = await h.user({ discordId: nextDiscord() });
    const { key } = await v.api.account.createApiKey({ name: "k", permissions: [], expiresAt: null });
    const kctx = await createApiKeyCtx(key);
    await expect(caller(kctx).account.passkeys.registerOptions()).rejects.toThrow(/NOT_WITH_API_KEY/);
  });

  it("weigert verkeerde challenge, origin, RP ID, ontbrekende UV en hergebruik", async () => {
    const u = await h.user({ discordId: nextDiscord() });
    const reg = async (over: Parameters<SoftPasskey["register"]>[1]) => {
      const opts = (await u.api.account.passkeys.registerOptions()) as { challenge: string };
      return u.api.account.passkeys.register({ name: "x", response: asResp(new SoftPasskey().register(opts, over)) });
    };
    await expect(reg({ challenge: "bm9nLW5vb2l0LXVpdGdlZ2V2ZW4" })).rejects.toThrow(/INVALID_PASSKEY/);
    await expect(reg({ origin: "https://evil.test" })).rejects.toThrow(/INVALID_PASSKEY/);
    await expect(reg({ rpId: "evil.test" })).rejects.toThrow(/INVALID_PASSKEY/);
    await expect(reg({ userVerified: false })).rejects.toThrow(/INVALID_PASSKEY/);

    const opts = (await u.api.account.passkeys.registerOptions()) as { challenge: string };
    const resp = asResp(new SoftPasskey().register(opts));
    await u.api.account.passkeys.register({ name: "een", response: resp });
    // Zelfde challenge nogmaals (eenmalig).
    await expect(u.api.account.passkeys.register({ name: "twee", response: asResp(new SoftPasskey().register(opts)) })).rejects.toThrow(/INVALID_PASSKEY/);
    // Challenge van een andere gebruiker.
    const other = await h.user({ discordId: nextDiscord() });
    const o2 = (await other.api.account.passkeys.registerOptions()) as { challenge: string };
    await expect(u.api.account.passkeys.register({ name: "x", response: asResp(new SoftPasskey().register(o2)) })).rejects.toThrow(/INVALID_PASSKEY/);
    expect(await u.api.account.passkeys.list()).toHaveLength(1);
  });

  it("verlopen challenge wordt geweigerd", async () => {
    const u = await h.user({ discordId: nextDiscord() });
    const opts = (await u.api.account.passkeys.registerOptions()) as { challenge: string };
    await getDb().update(schema.webauthnChallenges).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.webauthnChallenges.challenge, opts.challenge));
    await expect(u.api.account.passkeys.register({ name: "x", response: asResp(new SoftPasskey().register(opts)) })).rejects.toThrow(/INVALID_PASSKEY/);
  });

  it("andermans passkey hernoemen/verwijderen → NOT_FOUND", async () => {
    const a = await h.user({ discordId: nextDiscord() });
    const b = await h.user({ discordId: nextDiscord() });
    const { row } = await registerKey(a);
    await expect(b.api.account.passkeys.rename({ id: row.id, name: "van mij" })).rejects.toThrow(/PASSKEY_NOT_FOUND/);
    await expect(b.api.account.passkeys.delete({ id: row.id })).rejects.toThrow(/PASSKEY_NOT_FOUND/);
    expect(await b.api.account.passkeys.list()).toHaveLength(0);
  });

  it("noodaccount krijgt geen passkeys", async () => {
    await setEmergencyCredentials("correct horse battery staple");
    const [em] = await getDb().select().from(schema.users).where(eq(schema.users.isEmergency, true));
    const { createSession, SESSION_COOKIE } = await import("./session");
    const { token } = await createSession(em!.id, { ip: "127.0.0.1", userAgent: "vitest", totpVerified: true });
    await getDb().update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, em!.id));
    const api = caller(await h.ctxFor(`${SESSION_COOKIE}=${token}`));
    await expect(api.account.passkeys.registerOptions()).rejects.toThrow(/EMERGENCY_ACCOUNT/);
  });
});

async function createApiKeyCtx(key: string) {
  const { createContext } = await import("./context");
  return createContext(new Request("http://panel.test/api/trpc", { headers: { authorization: `Bearer ${key}` } }), new Headers());
}

describe("passkeys: login zonder gebruikersnaam", () => {
  it("maakt een geverifieerde sessie, ook met TOTP aan; teller en laatst gebruikt bijgewerkt; gelogd", async () => {
    const u = await h.user({ discordId: nextDiscord(), totp: true });
    const { pk, row } = await registerKey(u);
    const ip = freshIp();
    const s = await passkeyLogin(pk, {}, ip);
    expect(s.ctx.session).toMatchObject({ userId: u.id, totpEnabled: true, totpVerified: true });
    expect((await s.api.account.get()).user.id).toBe(u.id);
    const [db] = await getDb().select().from(schema.passkeys).where(eq(schema.passkeys.id, row.id));
    expect(db!.counter).toBe(1);
    expect(db!.lastUsedAt).toBeInstanceOf(Date);
    const log = await actions("auth.login", u.id);
    expect(log.some((l) => (l.metadata as { via?: string }).via === "passkey" && l.ip === ip)).toBe(true);
  });

  it("admin zonder TOTP blijft geen admin na passkey-login (TOTP_REQUIRED); met TOTP wel", async () => {
    const owner = await h.user({ discordId: OWNER, admin: true });
    const { pk } = await registerKey(owner);
    const s = await passkeyLogin(pk);
    await expect(s.api.admin.users.list({})).rejects.toThrow(/TOTP_REQUIRED/);
    await getDb().update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, owner.id));
    const s2 = await passkeyLogin(pk);
    await expect(s2.api.admin.users.list({})).resolves.toBeTruthy();
  });

  it("weigert verkeerde challenge, origin, RP ID, zonder UV, hergebruik en onbekende credential", async () => {
    const u = await h.user({ discordId: nextDiscord() });
    const { pk } = await registerKey(u);
    await expect(passkeyLogin(pk, { challenge: "dmVyemFtZWxkZS1jaGFsbGVuZ2U" })).rejects.toThrow(/INVALID_PASSKEY/);
    await expect(passkeyLogin(pk, { origin: "https://evil.test" })).rejects.toThrow(/INVALID_PASSKEY/);
    await expect(passkeyLogin(pk, { rpId: "evil.test" })).rejects.toThrow(/INVALID_PASSKEY/);
    await expect(passkeyLogin(pk, { userVerified: false })).rejects.toThrow(/INVALID_PASSKEY/);
    await expect(passkeyLogin(pk, { userHandle: "YW5kZXJlLWdlYnJ1aWtlcg" })).rejects.toThrow(/INVALID_PASSKEY/);
    await expect(passkeyLogin(new SoftPasskey())).rejects.toThrow(/INVALID_PASSKEY/);

    // Hergebruik: dezelfde response (zelfde challenge) een tweede keer.
    const a = await anon();
    const opts = await a.api.auth.passkeyLoginOptions();
    const resp = asResp(pk.assert(opts));
    await a.api.auth.passkeyLogin({ response: resp });
    await expect(a.api.auth.passkeyLogin({ response: resp })).rejects.toThrow(/INVALID_PASSKEY/);
    expect((await actions("auth.passkey_login.failed")).length).toBeGreaterThanOrEqual(7);
  });

  it("teller die niet stijgt (gekloonde sleutel) wordt geweigerd", async () => {
    const u = await h.user({ discordId: nextDiscord() });
    const { pk } = await registerKey(u);
    await passkeyLogin(pk, { counter: 5 });
    await expect(passkeyLogin(pk, { counter: 5 })).rejects.toThrow(/INVALID_PASSKEY/);
    await expect(passkeyLogin(pk, { counter: 3 })).rejects.toThrow(/INVALID_PASSKEY/);
    await expect(passkeyLogin(pk, { counter: 6 })).resolves.toBeTruthy();
  });

  it("geblokkeerde gebruiker → BLOCKED", async () => {
    const u = await h.user({ discordId: nextDiscord() });
    const { pk } = await registerKey(u);
    await getDb().update(schema.users).set({ blocked: true }).where(eq(schema.users.id, u.id));
    await expect(passkeyLogin(pk)).rejects.toThrow(/BLOCKED/);
    expect((await actions("auth.login.blocked", u.id)).length).toBe(1);
  });

  it("rate limit per IP na mislukte pogingen", async () => {
    const ip = freshIp();
    const stranger = new SoftPasskey();
    for (let i = 0; i < PASSKEY_LOGIN_IP_MAX; i++) await expect(passkeyLogin(stranger, {}, ip)).rejects.toThrow(/INVALID_PASSKEY/);
    const u = await h.user({ discordId: nextDiscord() });
    const { pk } = await registerKey(u);
    await expect(passkeyLogin(pk, {}, ip)).rejects.toThrow(/TOO_MANY_ATTEMPTS/);
    await expect(passkeyLogin(pk, {}, freshIp())).resolves.toBeTruthy();
  });
});

describe("passkeys: tweede stap in plaats van TOTP", () => {
  it("pending sessie wordt geverifieerd met een eigen passkey; token geroteerd", async () => {
    const u = await h.user({ discordId: nextDiscord(), totp: true });
    const { pk } = await registerKey(u);
    const p = await h.user({ discordId: u.discordId, totp: true, verified: false });
    // h.user zet TOTP opnieuw; de passkey blijft van dezelfde gebruiker.
    expect(p.id).toBe(u.id);
    await expect(p.api.account.get()).rejects.toThrow(/TOTP_PENDING/);
    const opts = (await p.api.auth.passkeyVerifyOptions()) as { challenge: string; allowCredentials: { id: string }[] };
    expect(opts.allowCredentials.map((c) => c.id)).toEqual([pk.id]);
    await p.api.auth.passkeyVerify({ response: asResp(pk.assert(opts, { userVerified: false })) });
    const cookie = p.ctx.resHeaders.getSetCookie().find((c) => c.startsWith("panel_session="))!.split(";")[0]!;
    expect(cookie).not.toBe(p.cookie);
    const fresh = caller(await h.ctxFor(cookie));
    expect((await fresh.account.get()).totpVerified).toBe(true);
    // Het oude token werkt niet meer.
    expect((await h.ctxFor(p.cookie)).session).toBeNull();
    const log = await actions("auth.totp.verified", u.id);
    expect(log.some((l) => (l.metadata as { via?: string }).via === "passkey")).toBe(true);
  });

  it("passkey van een andere gebruiker, verkeerde challenge of hergebruik → INVALID_PASSKEY", async () => {
    const a = await h.user({ discordId: nextDiscord(), totp: true });
    const b = await h.user({ discordId: nextDiscord(), totp: true });
    await registerKey(a);
    const { pk: bKey } = await registerKey(b);
    const pa = await h.user({ discordId: a.discordId, totp: true, verified: false });
    const opts = await pa.api.auth.passkeyVerifyOptions();
    await expect(pa.api.auth.passkeyVerify({ response: asResp(bKey.assert(opts)) })).rejects.toThrow(/INVALID_PASSKEY/);
    // Challenge van een andere sessie (b) werkt niet voor a.
    const pb = await h.user({ discordId: b.discordId, totp: true, verified: false });
    const ob = await pb.api.auth.passkeyVerifyOptions();
    await expect(pa.api.auth.passkeyVerify({ response: asResp(bKey.assert(ob)) })).rejects.toThrow(/INVALID_PASSKEY/);
    expect((await h.ctxFor(pa.cookie)).session!.totpVerified).toBe(false);
  });

  it("zonder passkeys → NO_PASSKEYS; zonder TOTP → TOTP_NOT_ENABLED", async () => {
    const p = await h.user({ discordId: nextDiscord(), totp: true, verified: false });
    await expect(p.api.auth.passkeyVerifyOptions()).rejects.toThrow(/NO_PASSKEYS/);
    const n = await h.user({ discordId: nextDiscord() });
    await expect(n.api.auth.passkeyVerifyOptions()).rejects.toThrow(/TOTP_NOT_ENABLED/);
  });
});

describe("passkeys: admin", () => {
  it("ziet de passkeys van een gebruiker en verwijdert ze allemaal (gelogd)", async () => {
    const owner = await h.user({ discordId: OWNER, admin: true, totp: true });
    const u = await h.user({ discordId: nextDiscord() });
    await registerKey(u, "een");
    const { pk } = await registerKey(u, "twee");
    expect((await owner.api.admin.users.passkeys({ id: u.id })).map((p) => p.name)).toEqual(["een", "twee"]);
    expect(await owner.api.admin.users.deletePasskeys({ id: u.id })).toEqual({ deleted: 2 });
    expect(await owner.api.admin.users.passkeys({ id: u.id })).toEqual([]);
    await expect(passkeyLogin(pk)).rejects.toThrow(/INVALID_PASSKEY/);
    expect((await actions("admin.user.passkeys.delete", owner.id)).length).toBe(1);
    await expect(u.api.admin.users.deletePasskeys({ id: u.id })).rejects.toThrow(/TOTP_REQUIRED|NOT_ADMIN/);
    await expect(owner.api.admin.users.passkeys({ id: 999999 })).rejects.toThrow(/USER_NOT_FOUND/);
  });
});
