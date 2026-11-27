import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb, schema } from "./db";
import { sha256 } from "./lib/crypto";
import { totpAt } from "./lib/totp";
import { normalizeRecoveryCode } from "./recovery";
import { useHarness } from "./test/harness";

const h = useHarness();

/** Zet 2FA aan via de echte flow en geeft de herstelcodes terug. */
async function enable(discordId: string) {
  const u = await h.user({ discordId });
  const setup = await u.api.account.totpSetup();
  const r = await u.api.account.totpEnable({ code: totpAt(setup.secret, Math.floor(Date.now() / 30_000)) });
  return { u, secret: setup.secret, codes: r.recoveryCodes };
}

/** Een nieuwe sessie van dezelfde gebruiker die nog TOTP moet invoeren. */
async function pendingSession(userId: number) {
  const { createSession, SESSION_COOKIE } = await import("./session");
  const { token } = await createSession(userId, { ip: "127.0.0.1", userAgent: "vitest", totpVerified: false });
  return h.refresh({ id: userId, cookie: `${SESSION_COOKIE}=${token}` } as never);
}

describe("herstelcodes", () => {
  it("totpEnable geeft 10 codes, opgeslagen als hash", async () => {
    const { u, codes } = await enable("610000000000000001");
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
    const rows = await getDb().select().from(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, u.id));
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.codeHash)).toContain(sha256(codes[0]!));
    expect(JSON.stringify(rows)).not.toContain(codes[0]!);
    expect(await u.api.account.recoveryCodesStatus()).toEqual({ remaining: 10, total: 10 });
  });

  it("verifyTotp accepteert een herstelcode eenmalig en logt het", async () => {
    const { u, codes } = await enable("610000000000000002");
    const s = await pendingSession(u.id);
    await expect(s.api.servers.list()).rejects.toThrow(/TOTP_PENDING/);
    const r = await s.api.auth.verifyTotp({ code: codes[0]!.toUpperCase().replace("-", " ") });
    expect(r).toEqual({ ok: true, recoveryCodesLeft: 9 });
    await expect((await h.refresh(s)).api.servers.list()).resolves.toBeDefined();
    // Dezelfde code nogmaals: geweigerd
    const s2 = await pendingSession(u.id);
    await expect(s2.api.auth.verifyTotp({ code: codes[0]! })).rejects.toThrow(/INVALID_CODE/);
    const log = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.userId, u.id));
    expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(["auth.recovery_code.used", "auth.totp.failed"]));
    expect(await u.api.account.recoveryCodesStatus()).toMatchObject({ remaining: 9 });
  });

  it("waarschuwt bij 2 of minder over", async () => {
    const { u, codes } = await enable("610000000000000003");
    let last: number | null = null;
    for (const c of codes.slice(0, 8)) last = (await (await pendingSession(u.id)).api.auth.verifyTotp({ code: c })).recoveryCodesLeft;
    expect(last).toBe(2);
    const log = await getDb().select().from(schema.activityLog).where(eq(schema.activityLog.userId, u.id));
    expect(log.some((l) => l.action === "auth.recovery_code.used" && (l.metadata as { warning?: boolean }).warning === true)).toBe(true);
  });

  it("onbekende code en foute indeling worden geweigerd; TOTP-code is geen herstelcode", async () => {
    const { u } = await enable("610000000000000004");
    const s = await pendingSession(u.id);
    await expect(s.api.auth.verifyTotp({ code: "abcde-fghjk" })).rejects.toThrow(/INVALID_CODE/);
    await expect(s.api.auth.verifyTotp({ code: "zzzz" + "zzzzzzzz" })).rejects.toThrow(/INVALID_CODE/);
    expect(normalizeRecoveryCode("123456")).toBeNull();
  });

  it("blokkeert na 5 foute pogingen (ook voor een geldige herstelcode)", async () => {
    const { u, codes } = await enable("610000000000000005");
    const s = await pendingSession(u.id);
    for (let i = 0; i < 5; i++) await expect(s.api.auth.verifyTotp({ code: "bbbbb-ccccc" })).rejects.toThrow(/INVALID_CODE/);
    await expect(s.api.auth.verifyTotp({ code: codes[0]! })).rejects.toThrow(/TOO_MANY_ATTEMPTS/);
  });

  it("regenereren vereist een geldige TOTP-code en maakt oude codes ongeldig", async () => {
    const { u, secret, codes } = await enable("610000000000000006");
    await expect(u.api.account.regenerateRecoveryCodes({ code: "000000" })).rejects.toThrow(/INVALID_CODE/);
    const fresh = await u.api.account.regenerateRecoveryCodes({ code: totpAt(secret, Math.floor(Date.now() / 30_000) + 1) });
    expect(fresh.recoveryCodes).toHaveLength(10);
    expect(fresh.recoveryCodes).not.toContain(codes[0]);
    await expect((await pendingSession(u.id)).api.auth.verifyTotp({ code: codes[1]! })).rejects.toThrow(/INVALID_CODE/);
    await expect((await pendingSession(u.id)).api.auth.verifyTotp({ code: fresh.recoveryCodes[0]! })).resolves.toMatchObject({ recoveryCodesLeft: 9 });
  });

  it("uitzetten van 2FA ruimt de codes op", async () => {
    const { u, secret } = await enable("610000000000000007");
    await u.api.account.totpDisable({ code: totpAt(secret, Math.floor(Date.now() / 30_000) - 1) });
    expect(await getDb().select().from(schema.recoveryCodes).where(eq(schema.recoveryCodes.userId, u.id))).toHaveLength(0);
  });
});
