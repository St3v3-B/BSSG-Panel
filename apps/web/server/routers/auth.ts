import type { Implementation, Me } from "@panel/api";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { logActivity } from "../activity";
import { secureFor } from "../context";
import { getDb, schema } from "../db";
import { loginUrl } from "../discord";
import { decrypt, encrypt } from "../lib/crypto";
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

function checkCode(secretEnc: string | null, code: string): boolean {
  if (!secretEnc) return false;
  return verifyTotp(decrypt(secretEnc), code);
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
    if (!checkCode(u.totpSecretEnc, input.code)) {
      await logActivity({ action: "auth.totp.failed", userId: u.id, ip: ctx.ip });
      throw invalidCode();
    }
    await getDb().update(schema.sessions).set({ totpVerified: true }).where(eq(schema.sessions.id, s.sessionId));
    await logActivity({ action: "auth.totp.verified", userId: u.id, ip: ctx.ip });
    return ok;
  },

  logout: async ({ ctx }) => {
    const s = ctx.session!;
    await deleteSession(s.sessionId);
    ctx.resHeaders.append("set-cookie", clearSessionCookie(secureFor(ctx)));
    await logActivity({ action: "auth.logout", userId: s.userId, ip: ctx.ip });
    return ok;
  },
};

export const account: Pick<Implementation["account"], "get" | "totpSetup" | "totpEnable" | "totpDisable"> = {
  get: async ({ ctx }) => meFor(ctx.session!),

  totpSetup: async ({ ctx }: { ctx: Ctx }) => {
    const u = await userRow(ctx.session!.userId);
    if (u.totpEnabled) throw new TRPCError({ code: "CONFLICT", message: "TOTP_ALREADY_ENABLED" });
    const secret = generateTotpSecret();
    await getDb().update(schema.users).set({ totpSecretEnc: encrypt(secret) }).where(eq(schema.users.id, u.id));
    const { panelName } = await getSettings();
    return { secret, otpauthUrl: otpauthUrl(secret, u.name ?? u.discordId ?? `user${u.id}`, panelName) };
  },

  totpEnable: async ({ input, ctx }) => {
    const s = ctx.session!;
    const u = await userRow(s.userId);
    if (u.totpEnabled) throw new TRPCError({ code: "CONFLICT", message: "TOTP_ALREADY_ENABLED" });
    if (!u.totpSecretEnc) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "TOTP_SETUP_FIRST" });
    if (!checkCode(u.totpSecretEnc, input.code)) throw invalidCode();
    const db = getDb();
    await db.transaction(async (tx) => {
      await tx.update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, u.id));
      // Andere sessies moeten voortaan de code invoeren; deze is geverifieerd.
      await tx.update(schema.sessions).set({ totpVerified: false }).where(eq(schema.sessions.userId, u.id));
      await tx.update(schema.sessions).set({ totpVerified: true }).where(eq(schema.sessions.id, s.sessionId));
    });
    await logActivity({ action: "account.totp.enable", userId: u.id, ip: ctx.ip });
    return { ok: true as const };
  },

  totpDisable: async ({ input, ctx }) => {
    const u = await userRow(ctx.session!.userId);
    if (!u.totpEnabled) throw new TRPCError({ code: "BAD_REQUEST", message: "TOTP_NOT_ENABLED" });
    if (!checkCode(u.totpSecretEnc, input.code)) throw invalidCode();
    await getDb().update(schema.users).set({ totpEnabled: false, totpSecretEnc: null }).where(eq(schema.users.id, u.id));
    await logActivity({ action: "account.totp.disable", userId: u.id, ip: ctx.ip });
    return { ok: true as const };
  },
};
