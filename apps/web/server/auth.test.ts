import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as discordCallback } from "@/app/api/auth/discord/callback/route";
import { GET as discordLogin } from "@/app/api/auth/discord/login/route";
import { POST as testLoginRoute } from "@/app/api/auth/test/login/route";
import { getDb, schema } from "./db";
import { resetEnv } from "./env";
import { totpNow } from "./lib/totp";
import { authProxy } from "./proxy";
import { sha256 } from "./lib/crypto";
import { OWNER, useHarness } from "./test/harness";

const h = useHarness();

const testLogin = (body: unknown) =>
  testLoginRoute(new Request("http://127.0.0.1:3000/api/auth/test/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

const cookieOf = (res: Response, name = "panel_session") => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

describe("test-login", () => {
  it("maakt account + sessie aan en zet panel_session (HttpOnly, Lax, niet Secure over http op .test)", async () => {
    const res = await testLogin({ discordId: "300000000000000001", name: "Tester" });
    expect(res.status).toBe(200);
    const c = cookieOf(res)!;
    expect(c).toMatch(/HttpOnly/);
    expect(c).toMatch(/SameSite=Lax/);
    expect(c).not.toMatch(/Secure/);
    const token = decodeURIComponent(c.split(";")[0]!.split("=")[1]!);
    const [s] = await getDb().select().from(schema.sessions).where(eq(schema.sessions.tokenHash, sha256(token)));
    expect(s).toBeTruthy();
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.discordId, "300000000000000001"));
    expect(u).toMatchObject({ name: "Tester" });
    expect(u!.lastLoginAt).not.toBeNull();
    const log = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.userId, u!.id));
    expect(log.map((l) => l.action)).toContain("auth.login");
    // De sessie werkt via de context
    const api = (await h.refresh({ cookie: c.split(";")[0]! } as never)).api;
    expect((await api.auth.me())?.user.name).toBe("Tester");
  });

  it("vult een vooraf aangemaakt account bij de eerste login", async () => {
    await getDb().insert(schema.users).values({ discordId: "300000000000000002" });
    const res = await testLogin({ discordId: "300000000000000002", name: "Later" });
    expect(res.status).toBe(200);
    const rows = await getDb().select().from(schema.users).where(eq(schema.users.discordId, "300000000000000002"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Later");
  });

  it("weigert geblokkeerde gebruikers en ongeldige invoer", async () => {
    await getDb().insert(schema.users).values({ discordId: "300000000000000003", blocked: true });
    const res = await testLogin({ discordId: "300000000000000003", name: "x" });
    expect(res.status).toBe(403);
    expect(cookieOf(res)).toBeUndefined();
    expect((await testLogin({ discordId: "abc", name: "x" })).status).toBe(400);
  });

  it("bestaat niet zonder de vlag (404)", async () => {
    process.env.PANEL_INSECURE_TEST_LOGIN = "0";
    resetEnv();
    try {
      expect((await testLogin({ discordId: "300000000000000004", name: "x" })).status).toBe(404);
    } finally {
      process.env.PANEL_INSECURE_TEST_LOGIN = "1";
      resetEnv();
    }
  });
});

describe("Discord-login", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function startFlow(redirectTo = "/servers/abc") {
    const res = await discordLogin(new Request(`http://panel.test/api/auth/discord/login?redirectTo=${encodeURIComponent(redirectTo)}`));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin + loc.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(loc.searchParams.get("client_id")).toBe("test-client");
    expect(loc.searchParams.get("redirect_uri")).toBe("https://panel.test/api/auth/discord/callback");
    expect(loc.searchParams.get("scope")).toBe("identify");
    const stateCookie = cookieOf(res, "panel_oauth_state")!.split(";")[0]!;
    return { state: loc.searchParams.get("state")!, stateCookie };
  }

  function stubDiscord(user: Record<string, unknown>, opts: { tokenStatus?: number } = {}) {
    const real = globalThis.fetch;
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://discord.com/api/v10/oauth2/token")) {
        calls.push("token");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("code")).toBe("the-code");
        expect(body.get("client_secret")).toBe("test-secret");
        return new Response(JSON.stringify({ access_token: "at" }), { status: opts.tokenStatus ?? 200 });
      }
      if (url.startsWith("https://discord.com/api/v10/users/@me")) {
        calls.push("me");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer at");
        return new Response(JSON.stringify(user));
      }
      return real(input, init);
    });
    return calls;
  }

  const callback = (state: string, cookie: string, code = "the-code") =>
    discordCallback(new Request(`http://panel.test/api/auth/discord/callback?code=${code}&state=${state}`, { headers: { cookie } }));

  it("login → Discord → callback maakt account en sessie, redirect naar redirectTo", async () => {
    const { state, stateCookie } = await startFlow("/servers/abc");
    const calls = stubDiscord({ id: "400000000000000001", username: "dc", global_name: "Discord Naam", avatar: "abc123" });
    const res = await callback(state, stateCookie);
    expect(calls).toEqual(["token", "me"]);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/servers/abc");
    expect(cookieOf(res)).toBeTruthy();
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.discordId, "400000000000000001"));
    expect(u).toMatchObject({ name: "Discord Naam", avatarUrl: "https://cdn.discordapp.com/avatars/400000000000000001/abc123.png" });
  });

  it("weigert een verkeerde state en een open redirect", async () => {
    const { stateCookie } = await startFlow("//evil.example");
    const res = await callback("verkeerd", stateCookie);
    expect(res.headers.get("location")).toBe("/login?error=state");
    expect(cookieOf(res)).toBeUndefined();

    const flow = await startFlow("//evil.example");
    stubDiscord({ id: "400000000000000002", username: "x" });
    const ok = await callback(flow.state, flow.stateCookie);
    expect(ok.headers.get("location")).toBe("/");
  });

  it("geblokkeerd → geen sessie", async () => {
    await getDb().insert(schema.users).values({ discordId: "400000000000000003", blocked: true });
    const { state, stateCookie } = await startFlow();
    stubDiscord({ id: "400000000000000003", username: "geblokkeerd" });
    const res = await callback(state, stateCookie);
    expect(res.headers.get("location")).toBe("/login?error=blocked");
    expect(cookieOf(res)).toBeUndefined();
  });

  it("Discord-fout → terug naar /login", async () => {
    const { state, stateCookie } = await startFlow();
    stubDiscord({ id: "1" }, { tokenStatus: 400 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await callback(state, stateCookie);
    expect(res.headers.get("location")).toBe("/login?error=discord");
  });

  it("met 2FA: redirect naar de TOTP-stap", async () => {
    const u = await h.user({ discordId: "400000000000000004", totp: true });
    const { state, stateCookie } = await startFlow("/x");
    stubDiscord({ id: u.discordId, username: "met2fa" });
    const res = await callback(state, stateCookie);
    expect(res.headers.get("location")).toBe("/login?totp=1&redirectTo=%2Fx");
  });

  it("auth.discordLoginUrl wijst naar de login-route", async () => {
    const anon = await h.anon();
    expect((await anon.auth.discordLoginUrl({})).url).toBe("/api/auth/discord/login");
    expect((await anon.auth.discordLoginUrl({ redirectTo: "/admin" })).url).toBe("/api/auth/discord/login?redirectTo=%2Fadmin");
  });
});

describe("auth.* en context", () => {
  it("me is null zonder sessie; branding werkt altijd", async () => {
    const anon = await h.anon();
    expect(await anon.auth.me()).toBeNull();
    expect(await anon.auth.branding()).toEqual({ panelName: "Panel", logoUrl: null, accentColor: "#22c55e" });
    await expect(anon.servers.list()).rejects.toThrow(/UNAUTHORIZED/);
  });

  it("eigenaar is admin, maar admin vraagt eerst TOTP", async () => {
    const owner = await h.user({ discordId: OWNER, name: "eigenaar" });
    const me = await owner.api.auth.me();
    expect(me).toMatchObject({ isAdmin: true, isOwner: true, totpEnabled: false, totpVerified: true });
    await expect(owner.api.admin.nodes.list()).rejects.toThrow(/TOTP_REQUIRED/);
  });

  it("isAdmin wordt bij elk verzoek uit admin_discord_ids gelezen", async () => {
    const u = await h.user({ discordId: "500000000000000001", totp: true });
    expect((await u.api.auth.me())?.isAdmin).toBe(false);
    await getDb().insert(schema.adminDiscordIds).values({ discordId: u.discordId });
    const u2 = await h.refresh(u);
    expect((await u2.api.auth.me())?.isAdmin).toBe(true);
    await expect(u2.api.admin.nodes.list()).resolves.toBeTruthy();
    await getDb().delete(schema.adminDiscordIds).where(eq(schema.adminDiscordIds.discordId, u.discordId));
    await expect((await h.refresh(u)).api.admin.nodes.list()).rejects.toThrow(/NOT_ADMIN/);
  });

  it("verifyTotp: foute code geweigerd, goede code ontgrendelt de sessie", async () => {
    const u = await h.user({ discordId: "500000000000000002", totp: true, verified: false });
    expect((await u.api.auth.me())?.totpVerified).toBe(false);
    await expect(u.api.servers.list()).rejects.toThrow(/TOTP_PENDING/);
    await expect(u.api.auth.verifyTotp({ code: "000000" === h.totp(u) ? "111111" : "000000" })).rejects.toThrow(/INVALID_CODE/);
    await u.api.auth.verifyTotp({ code: h.totp(u) });
    const r = await h.refresh(u);
    expect((await r.api.auth.me())?.totpVerified).toBe(true);
    await expect(r.api.servers.list()).resolves.toEqual([]);
  });

  it("verifyTotp zonder TOTP → BAD_REQUEST", async () => {
    const u = await h.user({ discordId: "500000000000000003" });
    await expect(u.api.auth.verifyTotp({ code: "123456" })).rejects.toThrow(/TOTP_NOT_ENABLED/);
  });

  it("logout verwijdert de sessie en wist het cookie", async () => {
    const u = await h.user({ discordId: "500000000000000004" });
    await u.api.auth.logout();
    expect(u.ctx.resHeaders.getSetCookie()[0]).toMatch(/^panel_session=;.*Max-Age=0/);
    expect(await (await h.refresh(u)).api.auth.me()).toBeNull();
  });

  it("geblokkeerde gebruiker met bestaande sessie → BLOCKED", async () => {
    const u = await h.user({ discordId: "500000000000000005" });
    await getDb().update(schema.users).set({ blocked: true }).where(eq(schema.users.id, u.id));
    await expect((await h.refresh(u)).api.auth.logout()).rejects.toThrow(/BLOCKED/);
  });

  it("verlopen sessie telt niet", async () => {
    const u = await h.user({ discordId: "500000000000000006" });
    await getDb().update(schema.sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.sessions.userId, u.id));
    expect(await (await h.refresh(u)).api.auth.me()).toBeNull();
  });
});

describe("account.*", () => {
  it("get, totpSetup → totpEnable → andere sessies pending → totpDisable", async () => {
    const u = await h.user({ discordId: "600000000000000001", name: "acc" });
    expect((await u.api.account.get()).user.name).toBe("acc");
    const other = await h.user({ discordId: "600000000000000001", name: "acc" }); // tweede sessie
    const setup = await u.api.account.totpSetup();
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Panel%3Aacc\?secret=/);
    const [row] = await getDb().select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(row!.totpSecretEnc).toMatch(/^v1:/);
    expect(row!.totpSecretEnc).not.toContain(setup.secret);
    expect(row!.totpEnabled).toBe(false);

    await expect(u.api.account.totpEnable({ code: totpNow(setup.secret) === "000000" ? "111111" : "000000" })).rejects.toThrow(/INVALID_CODE/);
    await u.api.account.totpEnable({ code: totpNow(setup.secret) });
    const me = await (await h.refresh(u)).api.auth.me();
    expect(me).toMatchObject({ totpEnabled: true, totpVerified: true });
    expect((await (await h.refresh(other)).api.auth.me())?.totpVerified).toBe(false);
    await expect((await h.refresh(u)).api.account.totpSetup()).rejects.toThrow(/TOTP_ALREADY_ENABLED/);

    await (await h.refresh(u)).api.account.totpDisable({ code: totpNow(setup.secret) });
    const [after] = await getDb().select().from(schema.users).where(eq(schema.users.id, u.id));
    expect(after).toMatchObject({ totpEnabled: false, totpSecretEnc: null });
    const actions = (await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.userId, u.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["account.totp.enable", "account.totp.disable"]));
  });

  it("totpEnable zonder setup → PRECONDITION_FAILED", async () => {
    const u = await h.user({ discordId: "600000000000000002" });
    await expect(u.api.account.totpEnable({ code: "123456" })).rejects.toThrow(/TOTP_SETUP_FIRST/);
  });
});

describe("proxy", () => {
  const req = (path: string, cookie?: string) => new NextRequest(`http://panel.test${path}`, { headers: cookie ? { cookie } : {} });
  it("zonder cookie naar /login, met cookie door; /login, /api en bestanden altijd door", () => {
    const r = authProxy(req("/servers/x?tab=1"));
    expect(r.status).toBe(307);
    expect(r.headers.get("location")).toBe("http://panel.test/login?redirectTo=%2Fservers%2Fx%3Ftab%3D1");
    expect(authProxy(req("/")).headers.get("location")).toBe("http://panel.test/login");
    expect(authProxy(req("/servers/x", "panel_session=abc")).headers.get("location")).toBeNull();
    for (const p of ["/login", "/api/auth/discord/login", "/logo.png"]) expect(authProxy(req(p)).headers.get("location")).toBeNull();
  });
});
