import type { Implementation, Me } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { forbidApiKey } from "../apikey";
import { secureFor } from "../context";
import { getDb, schema } from "../db";
import { loginUrl } from "../discord";
import { decrypt, encrypt } from "../lib/crypto";
import { clearRecoveryCodes, consumeRecoveryCode, normalizeRecoveryCode, RECOVERY_WARN_AT, remainingRecoveryCodes, replaceRecoveryCodes } from "../recovery";
import { getLimiter } from "../lib/ratelimit";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp";
import { userPublic } from "../servers-data";
import { clearSessionCookie, deleteSession } from "../session";
import { getSettings } from "../settings";
import type { Ctx, SessionCtx } from "@panel/api";

const ok = { ok: true as const };

async function userRow(id: number) {
  const [u] = await getDb().select().from(schema.users).where(eq(schema.users.id, id));
  if (!u) throw new TRPCError({ code: "UNAUTHORIZED" });
  return u;
}

export async function meFor(s: SessionCtx): Promise<Me> {
  const u = await userRow(s.userId);
  return { user: userPublic(u), isAdmin: s.isAdmin, isOwner: s.isOwner, isEmergency: s.isEmergency, totpEnabled: s.totpEnabled, totpVerified: s.totpVerified };
}

export const TOTP_MAX_FAILURES = 5;
export const TOTP_WINDOW_SECONDS = 600;

/**
 * Controleert een TOTP-code met een limiet per gebruiker en per IP (5 fouten per 10 minuten, daarna
 * TOO_MANY_REQUESTS) en weigert hergebruik van dezelfde code binnen zijn geldigheid.
 */
async function checkCode(ctx: Ctx, userId: number, secretEnc: string | null, code: string): Promise<boolean> {
  const l = getLimiter();
  const keys = failKeys(ctx, userId);
  await assertNotLocked(keys);
  const good = !!secretEnc && verifyTotp(decrypt(secretEnc), code);
  // Dezelfde code werkt maar één keer (venster is +/-1 stap = 90 s).
  if (good && (await l.hit(`totp:used:${userId}:${code}`, 90)) > 1) {
    for (const k of keys) await l.hit(k, TOTP_WINDOW_SECONDS);
    return false;
  }
  if (!good) {
    for (const k of keys) await l.hit(k, TOTP_WINDOW_SECONDS);
    return false;
  }
  await l.reset(keys[0]!);
  return true;
}

const failKeys = (ctx: Ctx, userId: number) => [`totp:fail:u:${userId}`, ...(ctx.ip ? [`totp:fail:ip:${ctx.ip}`] : [])];
async function assertNotLocked(keys: string[]) {
  const l = getLimiter();
  for (const k of keys) if ((await l.get(k)) >= TOTP_MAX_FAILURES) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "TOO_MANY_ATTEMPTS" });
}

/** Herstelcode als alternatief voor TOTP, met dezelfde foutenlimiet. Geeft het aantal overgebleven codes of null. */
async function checkRecovery(ctx: Ctx, userId: number, code: string): Promise<number | null> {
  const keys = failKeys(ctx, userId);
  await assertNotLocked(keys);
  const left = await consumeRecoveryCode(userId, code);
  if (left === null) {
    for (const k of keys) await getLimiter().hit(k, TOTP_WINDOW_SECONDS);
    return null;
  }
  await getLimiter().reset(keys[0]!);
  return left;
}

const invalidCode = () => new TRPCError({ code: "BAD_REQUEST", message: "INVALID_CODE" });

export const auth: Pick<Implementation["auth"], "me" | "branding" | "discordLoginUrl" | "verifyTotp" | "logout"> = {
  me: async ({ ctx }) => (ctx.session ? meFor(ctx.session) : null),

  branding: async () => {
    const s = await getSettings();
    return { panelName: s.panelName, logoUrl: s.logoUrl, accentColor: s.accentColor };
  },

  discordLoginUrl: ({ input }) => ({ url: loginUrl(input.redirectTo) }),

  verifyTotp: async ({ input, ctx }) => {
    const s = ctx.session!;
    const u = await userRow(s.userId);
    if (!u.totpEnabled) throw new TRPCError({ code: "BAD_REQUEST", message: "TOTP_NOT_ENABLED" });
    let recoveryCodesLeft: number | null = null;
    if (/^\d{6}$/.test(input.code)) {
      if (!(await checkCode(ctx, u.id, u.totpSecretEnc, input.code))) {
        await logActivity({ action: "auth.totp.failed", userId: u.id, ip: ctx.ip, ctx });
        throw invalidCode();
      }
    } else {
      const left = normalizeRecoveryCode(input.code) ? await checkRecovery(ctx, u.id, input.code) : null;
      if (left === null) {
        await logActivity({ action: "auth.totp.failed", userId: u.id, ip: ctx.ip, metadata: { recovery: true }, ctx });
        throw invalidCode();
      }
      recoveryCodesLeft = left;
      await logActivity({ action: "auth.recovery_code.used", userId: u.id, ip: ctx.ip, metadata: { left, warning: left <= RECOVERY_WARN_AT }, ctx });
    }
    await getDb().update(schema.sessions).set({ totpVerified: true }).where(eq(schema.sessions.id, s.sessionId));
    await logActivity({ action: "auth.totp.verified", userId: u.id, ip: ctx.ip, ctx });
    return { ...ok, recoveryCodesLeft };
  },

  logout: async ({ ctx }) => {
    forbidApiKey(ctx);
    const s = ctx.session!;
    await deleteSession(s.sessionId);
    ctx.resHeaders.append("set-cookie", clearSessionCookie(secureFor(ctx)));
    await logActivity({ action: "auth.logout", userId: s.userId, ip: ctx.ip, ctx });
    return ok;
  },
};

export const account: Pick<Implementation["account"], "get" | "totpSetup" | "totpEnable" | "totpDisable" | "recoveryCodesStatus" | "regenerateRecoveryCodes"> = {
  get: async ({ ctx }) => meFor(ctx.session!),

  totpSetup: async ({ ctx }: { ctx: Ctx }) => {
    forbidApiKey(ctx);
    const u = await userRow(ctx.session!.userId);
    if (u.totpEnabled) throw new TRPCError({ code: "CONFLICT", message: "TOTP_ALREADY_ENABLED" });
    const secret = generateTotpSecret();
    await getDb().update(schema.users).set({ totpSecretEnc: encrypt(secret) }).where(eq(schema.users.id, u.id));
    const { panelName } = await getSettings();
    return { secret, otpauthUrl: otpauthUrl(secret, u.name ?? u.discordId ?? `user${u.id}`, panelName) };
  },

  totpEnable: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const s = ctx.session!;
    const u = await userRow(s.userId);
    if (u.totpEnabled) throw new TRPCError({ code: "CONFLICT", message: "TOTP_ALREADY_ENABLED" });
    if (!u.totpSecretEnc) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TOTP_SETUP_FIRST" });
    if (!(await checkCode(ctx, u.id, u.totpSecretEnc, input.code))) throw invalidCode();
    const db = getDb();
    let recoveryCodes: string[] = [];
    await db.transaction(async (tx) => {
      recoveryCodes = await replaceRecoveryCodes(u.id, tx);
      await tx.update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, u.id));
      // Andere sessies moeten voortaan de code invoeren; deze is geverifieerd.
      await tx.update(schema.sessions).set({ totpVerified: false }).where(eq(schema.sessions.userId, u.id));
      await tx.update(schema.sessions).set({ totpVerified: true }).where(eq(schema.sessions.id, s.sessionId));
    });
    await logActivity({ action: "account.totp.enable", userId: u.id, ip: ctx.ip, ctx });
    return { ok: true as const, recoveryCodes };
  },

  recoveryCodesStatus: async ({ ctx }) => ({ remaining: await remainingRecoveryCodes(ctx.session!.userId), total: 10 }),

  regenerateRecoveryCodes: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const u = await userRow(ctx.session!.userId);
    if (!u.totpEnabled) throw new TRPCError({ code: "BAD_REQUEST", message: "TOTP_NOT_ENABLED" });
    if (!(await checkCode(ctx, u.id, u.totpSecretEnc, input.code))) throw invalidCode();
    const recoveryCodes = await replaceRecoveryCodes(u.id);
    await logActivity({ action: "account.recovery_codes.regenerate", userId: u.id, ip: ctx.ip, ctx });
    return { recoveryCodes };
  },

  totpDisable: async ({ input, ctx }) => {
    forbidApiKey(ctx);
    const u = await userRow(ctx.session!.userId);
    if (!u.totpEnabled) throw new TRPCError({ code: "BAD_REQUEST", message: "TOTP_NOT_ENABLED" });
    if (!(await checkCode(ctx, u.id, u.totpSecretEnc, input.code))) throw invalidCode();
    await getDb().update(schema.users).set({ totpEnabled: false, totpSecretEnc: null }).where(eq(schema.users.id, u.id));
    await clearRecoveryCodes(u.id);
    await logActivity({ action: "account.totp.disable", userId: u.id, ip: ctx.ip, ctx });
    return { ok: true as const };
  },
};
