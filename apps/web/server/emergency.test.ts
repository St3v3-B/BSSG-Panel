import { execFileSync } from "node:child_process";
import { buildRouter, createCallerFactory } from "@panel/api";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { emergencyAlerts, setEmergencyCredentials } from "./emergency";
import { implementation } from "./index";
import { getLimiter } from "./lib/ratelimit";
import { totpAt } from "./lib/totp";
import { OWNER, useHarness } from "./test/harness";

const h = useHarness();
const caller = createCallerFactory(buildRouter(implementation));
const PASSWORD = "correct horse battery staple";
const step = () => Math.floor(Date.now() / 30_000);

async function login(ip: string, password: string, code: string) {
  const ctx = { ...(await h.ctxFor(null)), ip };
  const res = await caller(ctx).auth.emergencyLogin({ password, code });
  const cookie = ctx.resHeaders.getSetCookie()[0]!.split(";")[0]!;
  return { res, cookie };
}

let secret = "";

describe("noodaccount", () => {
  it("CLI-logica: stelt wachtwoord (Argon2id) en versleuteld TOTP-secret in; te kort wachtwoord geweigerd", async () => {
    await expect(setEmergencyCredentials("kort")).rejects.toThrow(/at least/);
    const r = await setEmergencyCredentials(PASSWORD);
    secret = r.secret;
    expect(r.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    const [u] = await getDb().select().from(schema.users).where(eq(schema.users.isEmergency, true));
    expect(u!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(u!.totpSecretEnc).toMatch(/^v1:/);
    expect(u!.totpEnabled).toBe(true);
    expect(u!.discordId).toBeNull();
    // Opnieuw uitvoeren vervangt, er blijft precies één noodaccount
    const again = await setEmergencyCredentials(PASSWORD);
    secret = again.secret;
    expect(again.created).toBe(false);
    expect(await getDb().select().from(schema.users).where(eq(schema.users.isEmergency, true))).toHaveLength(1);
  });

  it("wachtwoord + TOTP geven een adminsessie; gebruik wordt gelogd en getoond op het dashboard", async () => {
    const { res, cookie } = await login("203.0.113.1", PASSWORD, totpAt(secret, step()));
    expect(res).toEqual({ ok: true });
    const ctx = await h.ctxFor(cookie);
    expect(ctx.session).toMatchObject({ isAdmin: true, isEmergency: true, totpVerified: true });
    const api = caller(ctx);
    expect(await api.auth.me()).toMatchObject({ isAdmin: true, isEmergency: true });
    const dash = await api.admin.dashboard();
    expect(dash.alerts.some((a) => a.kind === "emergency_login" && a.message.includes("203.0.113.1"))).toBe(true);
    expect(dash.userCount).not.toBeGreaterThan(1000);
    const log = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "auth.emergency_login"));
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]!.ip).toBe("203.0.113.1");
  });

  it("fout wachtwoord, foute TOTP, hergebruikte TOTP: zelfde fout, wordt gelogd", async () => {
    await expect(login("203.0.113.2", "wrong password here!", totpAt(secret, step() - 1))).rejects.toThrow(/INVALID_CREDENTIALS/);
    await expect(login("203.0.113.2", PASSWORD, "000000" === totpAt(secret, step()) ? "111111" : "000000")).rejects.toThrow(/INVALID_CREDENTIALS/);
    await expect(login("203.0.113.2", PASSWORD, totpAt(secret, step() + 1))).resolves.toBeTruthy();
    // dezelfde code nog eens: replay
    await expect(login("203.0.113.2", PASSWORD, totpAt(secret, step() + 1))).rejects.toThrow(/INVALID_CREDENTIALS/);
    const failed = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.action, "auth.emergency_login.failed"));
    expect(failed.length).toBeGreaterThanOrEqual(3);
  });

  it("alleen wachtwoord of alleen TOTP is niet genoeg (code is verplicht in de input)", async () => {
    const api = caller({ ...(await h.ctxFor(null)), ip: "203.0.113.3" });
    await expect(api.auth.emergencyLogin({ password: PASSWORD, code: "" })).rejects.toThrow();
    await expect(login("203.0.113.3", PASSWORD, "123456")).rejects.toThrow(/INVALID_CREDENTIALS/);
  });

  it("normale gebruiker kan er niet mee inloggen; geen noodaccount ingesteld geeft dezelfde fout", async () => {
    await h.user({ discordId: OWNER, admin: true });
    await expect(login("203.0.113.4", "x".repeat(16), "123456")).rejects.toThrow(/INVALID_CREDENTIALS/);
    await getDb().update(schema.users).set({ passwordHash: null }).where(eq(schema.users.isEmergency, true));
    await expect(login("203.0.113.4", PASSWORD, totpAt(secret, step() + 1))).rejects.toThrow(/INVALID_CREDENTIALS/);
    await setEmergencyCredentials(PASSWORD).then((r) => (secret = r.secret));
  });

  it("rate limit per IP: na 5 fouten TOO_MANY_REQUESTS, ook met goede gegevens; ander IP kan nog", async () => {
    for (let i = 0; i < 5; i++) await expect(login("198.51.100.1", "nope nope nope nope", "123456")).rejects.toThrow(/INVALID_CREDENTIALS/);
    await expect(login("198.51.100.1", PASSWORD, totpAt(secret, step()))).rejects.toThrow(/TOO_MANY_ATTEMPTS/);
    await expect(login("198.51.100.2", PASSWORD, totpAt(secret, step() + 1))).resolves.toBeTruthy();
  });

  it("globale limiet over alle IP's", async () => {
    await getLimiter().reset("emergency:fail:global");
    for (let i = 0; i < 20; i++) await expect(login(`192.0.2.${i + 1}`, "nope nope nope nope", "123456")).rejects.toThrow(/INVALID_CREDENTIALS/);
    await expect(login("192.0.2.200", PASSWORD, totpAt(secret, step() - 1))).rejects.toThrow(/TOO_MANY_ATTEMPTS/);
    await getLimiter().reset("emergency:fail:global");
  });

  it("emergencyAlerts: alleen laatste dagen", async () => {
    expect((await emergencyAlerts()).length).toBeGreaterThan(0);
    expect(await emergencyAlerts(new Date(Date.now() + 30 * 86400_000))).toHaveLength(0);
  });

  it("CLI (server/cli/emergency.ts) stelt het account in en toont secret + QR", async () => {
    const out = execFileSync("npx", ["tsx", "server/cli/emergency.ts"], {
      env: { ...process.env, ...h.env, EMERGENCY_PASSWORD: "cli password long enough" },
      encoding: "utf8",
      timeout: 60_000,
    });
    const m = out.match(/Secret \(manual entry\): ([A-Z2-7]+)/);
    expect(m).toBeTruthy();
    expect(out).toContain("otpauth://totp/");
    await getLimiter().reset("emergency:fail:ip:203.0.113.50");
    const { res } = await login("203.0.113.50", "cli password long enough", totpAt(m![1]!, step()));
    expect(res).toEqual({ ok: true });
  });
});
